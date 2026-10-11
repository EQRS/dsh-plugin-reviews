/**
 * 评论与可见性测试（工作包 GC）。
 *
 * 纪律：每个用例都必须能在实现被破坏时变红。关键对应关系：
 *  - 「撤回后 controlVersion 递增」→ 去掉 withdraw 里的 `+ 1`，触发器会 ABORT，用例变红；
 *  - 「已撤回/已隐藏不算公开」→ 把 resolveVisibility 的 `!withdrawn && !hidden` 去掉，用例变红；
 *  - 「回复回复时 root 仍是原顶层」→ 把 root 解析改成直接取 replyTo，触发器 ABORT，用例变红；
 *  - 「跨对象回复被拒且不留半截行」→ 去掉同对象校验，用例变红（触发器也会 ABORT）。
 *
 * 所有用例使用**真实临时文件数据库 + 真实迁移**，不用 :memory: 冒充。
 * 服务方法最后一个参数是平台层的连接注入点，测试用它把自己的临时库传进去。
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertReply,
  insertRepository,
  insertReview,
  insertReviewRevision,
  insertRootComment,
  insertUser,
  type TestDb,
} from './support/db';
import { commentsService } from '../src/server/modules/comments';
import { contentService, DEFAULT_WITHDRAWAL_REASON } from '../src/server/modules/content';
import type { CallerContext } from '../src/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';
import { newId } from '../src/server/platform/id';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

/**
 * 把一条评论标记为"已公开"（切公开修订 + 记首次公开时间）。
 *
 * 为什么需要它：架构第 78.2 / 79.2 节要求**未公开评论不得出现在公开列表**，
 * `listRootComments` / `listReplies` / `countReplies` 都按
 * `published_revision_id IS NOT NULL` 过滤。
 * 因此"公开列表应该看到几条"的用例必须先把评论发布出来，
 * 否则测的是"未公开内容泄不泄露"，而不是讨论组组织是否正确。
 */
function publishComment(db: TestDb['db'], commentId: string, now = Date.now()): void {
  const rev = db
    .prepare('SELECT id FROM comment_revisions WHERE comment_id = ? ORDER BY revision_number DESC LIMIT 1')
    .get(commentId) as { id: string } | undefined;
  if (!rev) throw new Error(`评论 ${commentId} 没有修订，无法发布`);
  db.prepare('UPDATE comments SET published_revision_id = ?, first_published_at = COALESCE(first_published_at, ?) WHERE id = ?').run(
    rev.id,
    now,
    commentId,
  );
}

/** 断言拒绝的是**具体错误码**，而不是宽泛的“有抛错就行”。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    if (!isDomainError(e)) {
      throw new Error(`预期 DomainError(${code})，实际是 ${(e as Error).name}: ${(e as Error).message}`);
    }
    expect(e.code, `实际错误码 ${e.code} / ${e.message}`).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
}

function caller(userId: string, role: 'user' | 'admin' = 'user'): CallerContext {
  return { userId, role, accountStatus: 'active' };
}

function countComments(db: TestDb['db'], entityId?: string): number {
  if (entityId) {
    return (db.prepare('SELECT count(*) AS c FROM comments WHERE content_entity_id = ?').get(entityId) as { c: number }).c;
  }
  return (db.prepare('SELECT count(*) AS c FROM comments').get() as { c: number }).c;
}

/** 建立一篇已公开的评测：内容实体 + 公开修订指针。返回 reviewId 与 revisionId。 */
function setupPublishedReview(
  db: TestDb['db'],
  author: string,
  pluginId: string | null,
): { reviewId: string; revisionId: string } {
  const reviewId = insertReview(db, { authorId: author, pluginId });
  if (pluginId === null) return { reviewId, revisionId: '' };
  const revisionId = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 1 });
  db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
  return { reviewId, revisionId };
}

// ============================================================
// 可见性统一解析
// ============================================================

describe('resolveVisibility：公开 = 有公开修订 且 未撤回 且 未隐藏', () => {
  it('未发布（无公开修订）不算公开', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const v = await contentService.resolveVisibility(reviewId, db);
    expect(v.hasPublishedRevision).toBe(false);
    expect(v.withdrawn).toBe(false);
    expect(v.hidden).toBe(false);
    expect(v.controlVersion).toBe(0);
    expect(v.publiclyVisible).toBe(false);
  });

  it('只有 latest_submitted_revision_id（尚未发布）仍不算公开', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewId = insertReview(db, { authorId: author, pluginId: plugin });
    const rev = insertReviewRevision(db, { reviewId, pluginId: plugin, revisionNumber: 1 });
    // 只写“最近提交”，公开指针仍为空
    db.prepare('UPDATE reviews SET latest_submitted_revision_id = ? WHERE id = ?').run(rev, reviewId);

    const v = await contentService.resolveVisibility(reviewId, db);
    expect(v.hasPublishedRevision).toBe(false);
    expect(v.publiclyVisible).toBe(false);
  });

  it('有公开修订且未撤回未隐藏 → 公开', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const { reviewId } = setupPublishedReview(db, author, plugin);

    const v = await contentService.resolveVisibility(reviewId, db);
    expect(v.hasPublishedRevision).toBe(true);
    expect(v.publiclyVisible).toBe(true);
  });

  it('已撤回但公开修订指针仍在 → 不算公开（可见性是算出来的，不是另存的字段）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const { reviewId, revisionId } = setupPublishedReview(db, author, plugin);

    const before = await contentService.resolveVisibility(reviewId, db);
    expect(before.publiclyVisible).toBe(true);

    await contentService.withdraw(
      caller(author),
      { reviewId, expectedControlVersion: before.controlVersion, reason: '作者撤回', requestKey: 'w1' },
      db,
    );

    const after = await contentService.resolveVisibility(reviewId, db);
    // ★ 公开修订指针**没有被清除**，但公开资格必须为 false —— 这条断言就是可见性计算的哨兵
    expect(after.hasPublishedRevision).toBe(true);
    expect(after.withdrawn).toBe(true);
    expect(after.publiclyVisible).toBe(false);
    expect(
      (db.prepare('SELECT published_revision_id AS r FROM reviews WHERE id = ?').get(reviewId) as { r: string }).r,
    ).toBe(revisionId);
  });

  it('已隐藏 → 不算公开；解除隐藏后恢复（撤回状态独立生效）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const { reviewId } = setupPublishedReview(db, author, plugin);

    await contentService.hide(caller(admin, 'admin'), { entityId: reviewId, reason: '违规内容', requestKey: 'h1' }, db);
    const hidden = await contentService.resolveVisibility(reviewId, db);
    expect(hidden.hidden).toBe(true);
    expect(hidden.withdrawn).toBe(false);
    expect(hidden.publiclyVisible).toBe(false);

    await contentService.unhide(caller(admin, 'admin'), { entityId: reviewId, reason: '申诉通过', requestKey: 'h2' }, db);
    const restored = await contentService.resolveVisibility(reviewId, db);
    expect(restored.hidden).toBe(false);
    expect(restored.publiclyVisible).toBe(true);
  });

  it('同时撤回并隐藏时，解除隐藏也不会重新公开', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const { reviewId } = setupPublishedReview(db, author, plugin);

    const v0 = await contentService.resolveVisibility(reviewId, db);
    await contentService.withdraw(
      caller(author),
      { reviewId, expectedControlVersion: v0.controlVersion, reason: null, requestKey: 'w' },
      db,
    );
    await contentService.hide(caller(admin, 'admin'), { entityId: reviewId, reason: '同时隐藏', requestKey: 'h' }, db);
    await contentService.unhide(caller(admin, 'admin'), { entityId: reviewId, reason: '解除隐藏', requestKey: 'u' }, db);

    const v = await contentService.resolveVisibility(reviewId, db);
    expect(v.hidden).toBe(false);
    expect(v.withdrawn).toBe(true);
    // 撤回独立生效：解除隐藏不等于恢复公开
    expect(v.publiclyVisible).toBe(false);
  });

  it('公开修订被指向另一篇文章的修订时不算有效公开修订', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewA = insertReview(db, { authorId: author, pluginId: plugin });
    const reviewB = insertReview(db, { authorId: author, pluginId: plugin });
    const revB = insertReviewRevision(db, { reviewId: reviewB, pluginId: plugin, revisionNumber: 1 });

    // 触发器会拒绝把 B 的修订挂到 A 上；这条断言证明该路径被数据库拦住
    expect(() =>
      db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revB, reviewA),
    ).toThrow(/不属于本篇评测/);

    const v = await contentService.resolveVisibility(reviewA, db);
    expect(v.hasPublishedRevision).toBe(false);
    expect(v.publiclyVisible).toBe(false);
  });

  it('不存在的内容标识被明确拒绝', async () => {
    const { db } = setup();
    await expectCode(contentService.resolveVisibility(newId(), db), ErrorCodes.TARGET_UNAVAILABLE);
  });
});

// ============================================================
// 撤回 / 隐藏 的权限与控制版本
// ============================================================

describe('withdraw：预期控制版本与递增', () => {
  it('撤回成功后 visibility_control_version 严格递增', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const before = await contentService.resolveVisibility(reviewId, db);
    const result = await contentService.withdraw(
      caller(author),
      { reviewId, expectedControlVersion: before.controlVersion, reason: '内容需要重写', requestKey: 'w1' },
      db,
    );

    expect(result.withdrawnAt).toBeGreaterThan(0);
    const after = await contentService.resolveVisibility(reviewId, db);
    // ★ 去掉实现里的 `visibility_control_version + 1` 会让触发器 ABORT；
    //   连触发器一起删掉则这里会读到相同的版本号 → 变红。
    expect(after.controlVersion).toBe(before.controlVersion + 1);

    const row = db
      .prepare('SELECT withdrawn_at, withdrawal_reason, visibility_control_version FROM content_entities WHERE id = ?')
      .get(reviewId) as { withdrawn_at: number; withdrawal_reason: string; visibility_control_version: number };
    expect(row.withdrawn_at).toBe(result.withdrawnAt);
    expect(row.withdrawal_reason).toBe('内容需要重写');
    expect(row.visibility_control_version).toBe(before.controlVersion + 1);
  });

  it('预期版本不符 → version_conflict，且数据库完全未改动', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await expectCode(
      contentService.withdraw(
        caller(author),
        { reviewId, expectedControlVersion: 7, reason: '错误的版本', requestKey: 'w-bad' },
        db,
      ),
      ErrorCodes.VERSION_CONFLICT,
    );

    const row = db
      .prepare('SELECT withdrawn_at, withdrawal_reason, visibility_control_version FROM content_entities WHERE id = ?')
      .get(reviewId) as {
      withdrawn_at: number | null;
      withdrawal_reason: string | null;
      visibility_control_version: number;
    };
    // ★ 去掉 WHERE 里的版本条件后，这里会读到 withdrawn_at 非空 → 变红
    expect(row.withdrawn_at).toBeNull();
    expect(row.withdrawal_reason).toBeNull();
    expect(row.visibility_control_version).toBe(0);
  });

  it('非作者不能撤回他人评测（管理员也不行，管理员走 hide）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const other = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await expectCode(
      contentService.withdraw(caller(other), { reviewId, expectedControlVersion: 0, reason: '越权', requestKey: 'w1' }, db),
      ErrorCodes.FORBIDDEN,
    );
    await expectCode(
      contentService.withdraw(
        caller(admin, 'admin'),
        { reviewId, expectedControlVersion: 0, reason: '越权', requestKey: 'w2' },
        db,
      ),
      ErrorCodes.FORBIDDEN,
    );

    const row = db.prepare('SELECT withdrawn_at FROM content_entities WHERE id = ?').get(reviewId) as {
      withdrawn_at: number | null;
    };
    expect(row.withdrawn_at).toBeNull();
  });

  it('重复撤回被拒：不能靠重复调用来刷版本号', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await contentService.withdraw(
      caller(author),
      { reviewId, expectedControlVersion: 0, reason: '第一次', requestKey: 'w1' },
      db,
    );

    await expectCode(
      contentService.withdraw(
        caller(author),
        { reviewId, expectedControlVersion: 1, reason: '第二次', requestKey: 'w2' },
        db,
      ),
      ErrorCodes.VERSION_CONFLICT,
    );

    const row = db
      .prepare('SELECT withdrawal_reason, visibility_control_version FROM content_entities WHERE id = ?')
      .get(reviewId) as { withdrawal_reason: string; visibility_control_version: number };
    expect(row.withdrawal_reason).toBe('第一次');
    expect(row.visibility_control_version).toBe(1);
  });

  it('撤回原因为 null 时落成占位文案：撤回时间与原因必须成对（表 CHECK）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await contentService.withdraw(
      caller(author),
      { reviewId, expectedControlVersion: 0, reason: null, requestKey: 'w' },
      db,
    );

    const row = db.prepare('SELECT withdrawn_at, withdrawal_reason FROM content_entities WHERE id = ?').get(reviewId) as {
      withdrawn_at: number;
      withdrawal_reason: string | null;
    };
    expect(row.withdrawn_at).toBeGreaterThan(0);
    // ★ 表上有 CHECK ((withdrawn_at IS NULL) = (withdrawal_reason IS NULL))：
    //   把 null 原样写进去会被数据库拒绝（裸 SqliteError），
    //   因此实现必须落一个明确文案。若实现漏掉这一步，本用例会以 SqliteError 变红。
    expect(row.withdrawal_reason).toBe(DEFAULT_WITHDRAWAL_REASON);
    expect(row.withdrawal_reason?.trim().length).toBeGreaterThan(0);
  });

  it('数据库层强制撤回时间与原因成对：只写时间不写原因会被拒绝', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    expect(() =>
      db
        .prepare('UPDATE content_entities SET withdrawn_at = ?, visibility_control_version = 1 WHERE id = ?')
        .run(Date.now(), reviewId),
    ).toThrow(/CHECK/i);
  });
});

describe('hide / unhide：管理员专用', () => {
  it('普通用户隐藏被拒，数据库未改动', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await expectCode(
      contentService.hide(caller(author), { entityId: reviewId, reason: '我要隐藏', requestKey: 'h' }, db),
      ErrorCodes.FORBIDDEN,
    );
    await expectCode(
      contentService.unhide(caller(author), { entityId: reviewId, reason: '解除', requestKey: 'u' }, db),
      ErrorCodes.FORBIDDEN,
    );

    const row = db.prepare('SELECT hidden_at FROM content_entities WHERE id = ?').get(reviewId) as {
      hidden_at: number | null;
    };
    expect(row.hidden_at).toBeNull();
  });

  it('隐藏写入 hidden_at/hidden_by/hidden_reason 三件套并递增版本；未隐藏时解除隐藏被拒', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await expectCode(
      contentService.unhide(caller(admin, 'admin'), { entityId: reviewId, reason: '解除', requestKey: 'u0' }, db),
      ErrorCodes.VERSION_CONFLICT,
    );

    const hidden = await contentService.hide(
      caller(admin, 'admin'),
      { entityId: reviewId, reason: '垃圾内容', requestKey: 'h1' },
      db,
    );
    expect(hidden.hiddenAt).toBeGreaterThan(0);

    const row = db
      .prepare(
        'SELECT hidden_at, hidden_by, hidden_reason, visibility_control_version FROM content_entities WHERE id = ?',
      )
      .get(reviewId) as {
      hidden_at: number;
      hidden_by: string;
      hidden_reason: string;
      visibility_control_version: number;
    };
    expect(row.hidden_at).toBe(hidden.hiddenAt);
    expect(row.hidden_by).toBe(admin);
    expect(row.hidden_reason).toBe('垃圾内容');
    expect(row.visibility_control_version).toBe(1);

    // 重复隐藏被拒
    await expectCode(
      contentService.hide(caller(admin, 'admin'), { entityId: reviewId, reason: '再来', requestKey: 'h2' }, db),
      ErrorCodes.VERSION_CONFLICT,
    );

    const unhidden = await contentService.unhide(
      caller(admin, 'admin'),
      { entityId: reviewId, reason: '申诉通过', requestKey: 'h3' },
      db,
    );
    expect(unhidden.hiddenAt).toBeNull();

    const after = db
      .prepare(
        'SELECT hidden_at, hidden_by, hidden_reason, visibility_control_version FROM content_entities WHERE id = ?',
      )
      .get(reviewId) as {
      hidden_at: number | null;
      hidden_by: string | null;
      hidden_reason: string | null;
      visibility_control_version: number;
    };
    // 三个隐藏字段必须同生共死（表上 CHECK 要求它们一致），版本必须继续递增
    expect(after.hidden_at).toBeNull();
    expect(after.hidden_by).toBeNull();
    expect(after.hidden_reason).toBeNull();
    expect(after.visibility_control_version).toBe(2);
  });

  it('隐藏原因为空被拒（原因必填），且不改动数据库', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await expectCode(
      contentService.hide(caller(admin, 'admin'), { entityId: reviewId, reason: '   ', requestKey: 'h' }, db),
      ErrorCodes.INPUT_INVALID,
    );
    expect(
      (db.prepare('SELECT hidden_at FROM content_entities WHERE id = ?').get(reviewId) as { hidden_at: number | null })
        .hidden_at,
    ).toBeNull();
  });
});

// ============================================================
// 评论盖楼
// ============================================================

describe('createComment：顶层与盖楼归属', () => {
  it('顶层评论：两列回复关联均为空，并落库评论+修订+提交各一条', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const created = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '顶层评论', requestKey: 'c1' },
      db,
    );

    const row = db
      .prepare(
        'SELECT reply_to_comment_id, root_comment_id, author_id, content_entity_id, created_at FROM comments WHERE id = ?',
      )
      .get(created.commentId) as {
      reply_to_comment_id: string | null;
      root_comment_id: string | null;
      author_id: string;
      content_entity_id: string;
      created_at: number;
    };
    expect(row.reply_to_comment_id).toBeNull();
    expect(row.root_comment_id).toBeNull();
    expect(row.author_id).toBe(author);
    expect(row.content_entity_id).toBe(reviewId);
    expect(row.created_at).toBeGreaterThan(0);

    const rev = db
      .prepare('SELECT comment_id, revision_number, body FROM comment_revisions WHERE id = ?')
      .get(created.revisionId) as { comment_id: string; revision_number: number; body: string };
    expect(rev.comment_id).toBe(created.commentId);
    expect(rev.revision_number).toBe(1);
    expect(rev.body).toBe('顶层评论');

    const sub = db
      .prepare(
        `SELECT submitted_by, submission_type, comment_revision_id, request_key, request_digest,
                processing_state, state_version, draft_id
         FROM content_submissions WHERE id = ?`,
      )
      .get(created.submissionId) as {
      submitted_by: string;
      submission_type: string;
      comment_revision_id: string;
      request_key: string;
      request_digest: string;
      processing_state: string;
      state_version: number;
      draft_id: string | null;
    };
    expect(sub.submitted_by).toBe(author);
    expect(sub.submission_type).toBe('comment_revision');
    expect(sub.comment_revision_id).toBe(created.revisionId);
    expect(sub.request_key).toBe('c1');
    expect(sub.request_digest).toMatch(/^[0-9a-f]{64}$/);
    // 评论提交不关联草稿（表上 CHECK 要求 draft_id 为空）
    expect(sub.draft_id).toBeNull();
    // 绝不直接视为通过
    expect(sub.processing_state).toBe('pending');
    expect(sub.state_version).toBe(0);

    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('回复顶层评论：root 解析为被回复者自身', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });
    const root = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '顶层', requestKey: 'r0' },
      db,
    );

    const reply = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '回复顶层', replyToCommentId: root.commentId, requestKey: 'r1' },
      db,
    );

    const row = db
      .prepare('SELECT reply_to_comment_id, root_comment_id FROM comments WHERE id = ?')
      .get(reply.commentId) as { reply_to_comment_id: string; root_comment_id: string };
    expect(row.reply_to_comment_id).toBe(root.commentId);
    expect(row.root_comment_id).toBe(root.commentId);
  });

  it('回复回复：root 仍是原顶层，不是被回复的那条回复', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });
    const root = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '顶层', requestKey: 'r0' },
      db,
    );
    const reply1 = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '第一层回复', replyToCommentId: root.commentId, requestKey: 'r1' },
      db,
    );

    const reply2 = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '回复那条回复', replyToCommentId: reply1.commentId, requestKey: 'r2' },
      db,
    );

    const row = db
      .prepare('SELECT reply_to_comment_id, root_comment_id FROM comments WHERE id = ?')
      .get(reply2.commentId) as { reply_to_comment_id: string; root_comment_id: string };
    expect(row.reply_to_comment_id).toBe(reply1.commentId);
    // ★ 若实现把 root 直接取成 replyTo，这里会是 reply1 → 变红（触发器也会 ABORT）
    expect(row.root_comment_id).toBe(root.commentId);

    // 三条评论同属一个讨论组
    const groupCount = (
      db
        .prepare('SELECT count(*) AS c FROM comments WHERE root_comment_id = ? OR id = ?')
        .get(root.commentId, root.commentId) as { c: number }
    ).c;
    expect(groupCount).toBe(3);
  });

  it('跨对象回复被拒：不能把 A 文章的评论挂到 B 文章下，且不留半截行', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewA = insertReview(db, { authorId: author, pluginId: plugin });
    const reviewB = insertReview(db, { authorId: author, pluginId: plugin });
    const rootA = insertRootComment(db, { contentEntityId: reviewA, authorId: author });

    const before = countComments(db);
    await expectCode(
      commentsService.createComment(
        caller(author),
        { contentEntityId: reviewB, body: '跨对象回复', replyToCommentId: rootA, requestKey: 'x1' },
        db,
      ),
      ErrorCodes.TARGET_UNAVAILABLE,
    );

    // ★ 去掉实现里的同对象校验后：触发器会 ABORT（仍是拒绝），
    //   但若连触发器一起删掉，这里就会出现 B 文章下的半截回复 → 行数变化 → 变红
    expect(countComments(db)).toBe(before);
    expect(
      (db.prepare('SELECT count(*) AS c FROM comments WHERE content_entity_id = ?').get(reviewB) as { c: number }).c,
    ).toBe(0);
  });

  it('被回复评论不存在：拒绝且不留半截行', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const before = countComments(db);
    await expectCode(
      commentsService.createComment(
        caller(author),
        { contentEntityId: reviewId, body: '悬空回复', replyToCommentId: newId(), requestKey: 'x2' },
        db,
      ),
      ErrorCodes.TARGET_UNAVAILABLE,
    );

    expect(countComments(db)).toBe(before);
    expect((db.prepare('SELECT count(*) AS c FROM comment_revisions').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM content_submissions').get() as { c: number }).c).toBe(0);
  });

  it('目标内容不存在：拒绝；空正文被拒；未登录被拒', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await expectCode(
      commentsService.createComment(caller(author), { contentEntityId: newId(), body: 'x', requestKey: 'k' }, db),
      ErrorCodes.TARGET_UNAVAILABLE,
    );

    await expectCode(
      commentsService.createComment(caller(author), { contentEntityId: reviewId, body: '   ', requestKey: 'k' }, db),
      ErrorCodes.INPUT_INVALID,
    );

    await expectCode(
      commentsService.createComment(
        { userId: null, role: null, accountStatus: null },
        { contentEntityId: reviewId, body: 'x', requestKey: 'k' },
        db,
      ),
      ErrorCodes.UNAUTHENTICATED,
    );

    expect(countComments(db)).toBe(0);
  });

  it('同一 requestKey 重复提交：复用原评论，不产生第二条评论', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const first = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '同键同内容', requestKey: 'dup-key' },
      db,
    );
    const second = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '同键同内容', requestKey: 'dup-key' },
      db,
    );

    expect(second.commentId).toBe(first.commentId);
    expect(second.revisionId).toBe(first.revisionId);
    expect(second.submissionId).toBe(first.submissionId);
    // ★ content_submissions 上有 UNIQUE(submitted_by, request_key)；去掉幂等分支会撞唯一键 → 变红
    expect(countComments(db)).toBe(1);
    expect((db.prepare('SELECT count(*) AS c FROM content_submissions').get() as { c: number }).c).toBe(1);
  });

  it('同一 requestKey 不同内容：抛 request_key_reused', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '原始内容', requestKey: 'reuse-key' },
      db,
    );

    await expectCode(
      commentsService.createComment(
        caller(author),
        { contentEntityId: reviewId, body: '换了内容', requestKey: 'reuse-key' },
        db,
      ),
      ErrorCodes.REQUEST_KEY_REUSED,
    );

    const bodies = (
      db.prepare('SELECT body FROM comment_revisions ORDER BY revision_number').all() as { body: string }[]
    ).map((r) => r.body);
    expect(bodies).toEqual(['原始内容']);
  });

  it('评论修订不可改写（不可变快照由触发器保证）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });
    const created = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '原始', requestKey: 'k' },
      db,
    );

    expect(() =>
      db.prepare('UPDATE comment_revisions SET body = ? WHERE id = ?').run('被改写', created.revisionId),
    ).toThrow(/不可改写/);
  });
});

describe('listRootComments / listReplies：分页与讨论组隔离', () => {
  it('顶层列表不含回复；total 与 items 一致；回复数正确', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const root1 = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '顶层一', requestKey: 'k1' },
      db,
    );
    const root2 = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '顶层二', requestKey: 'k2' },
      db,
    );
    await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '回复一', replyToCommentId: root1.commentId, requestKey: 'k3' },
      db,
    );
    await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '回复二', replyToCommentId: root2.commentId, requestKey: 'k4' },
      db,
    );

    // 公开这四条（未公开项不进公开列表，见 publishComment 说明）
    for (const id of [root1.commentId, root2.commentId]) publishComment(db, id);
    const replyRows = db.prepare('SELECT id FROM comments WHERE reply_to_comment_id IS NOT NULL').all() as { id: string }[];
    for (const r of replyRows) publishComment(db, r.id);

    const page = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(page.total).toBe(2);
    expect(page.items.map((c) => c.body)).toEqual(['顶层一', '顶层二']);
    // ★ 去掉 reply_to_comment_id IS NULL 过滤会把回复也算成顶层 → total 变 4 → 变红
    expect(page.items.every((c) => c.replyToCommentId === null && c.rootCommentId === null)).toBe(true);
    expect(page.items[0]?.replyCount).toBe(1);
    expect(page.items[1]?.replyCount).toBe(1);
    expect(page.total_pages).toBe(1);
    expect(page.has_next).toBe(false);
  });

  it('分页边界：首页与次页不重叠，越界页返回空但 total 不变', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    for (let i = 0; i < 3; i += 1) {
      const c = await commentsService.createComment(
        caller(author),
        { contentEntityId: reviewId, body: `第 ${i + 1} 条`, requestKey: `p${i}` },
        db,
      );
      publishComment(db, c.commentId);
    }

    const first = await commentsService.listRootComments(reviewId, { page: 1, page_size: 2 }, db);
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.total_pages).toBe(2);
    expect(first.has_next).toBe(true);
    expect(first.has_previous).toBe(false);

    const second = await commentsService.listRootComments(reviewId, { page: 2, page_size: 2 }, db);
    expect(second.items).toHaveLength(1);
    expect(second.has_next).toBe(false);
    expect(second.has_previous).toBe(true);

    const firstIds = first.items.map((c) => c.commentId);
    const secondIds = second.items.map((c) => c.commentId);
    // ★ OFFSET 写错时这里会出现重复条目 → 变红
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);

    const beyond = await commentsService.listRootComments(reviewId, { page: 9, page_size: 2 }, db);
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(3);
  });

  it('listReplies：返回整组回复（含更深层），不混入其他组', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });

    const rootA = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: 'A 顶层', requestKey: 'a0' },
      db,
    );
    const rootB = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: 'B 顶层', requestKey: 'b0' },
      db,
    );

    const a1 = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: 'A 的一层回复', replyToCommentId: rootA.commentId, requestKey: 'a1' },
      db,
    );
    await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: 'A 的二层回复', replyToCommentId: a1.commentId, requestKey: 'a2' },
      db,
    );
    await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: 'B 的一层回复', replyToCommentId: rootB.commentId, requestKey: 'b1' },
      db,
    );

    // 公开所有回复（未公开项不进回复列表）
    const replyIds = db.prepare('SELECT id FROM comments WHERE reply_to_comment_id IS NOT NULL').all() as { id: string }[];
    for (const r of replyIds) publishComment(db, r.id);

    const groupA = await commentsService.listReplies(rootA.commentId, { page: 1, page_size: 20 }, db);
    expect(groupA.total).toBe(2);
    expect(groupA.items.map((c) => c.body)).toEqual(['A 的一层回复', 'A 的二层回复']);
    // ★ 去掉 WHERE root_comment_id = ? 会把 B 组也带进来 → 变红
    expect(groupA.items.every((c) => c.rootCommentId === rootA.commentId)).toBe(true);

    const groupB = await commentsService.listReplies(rootB.commentId, { page: 1, page_size: 20 }, db);
    expect(groupB.total).toBe(1);
    expect(groupB.items.map((c) => c.body)).toEqual(['B 的一层回复']);
  });

  it('listReplies 传一条回复的 ID 会被拒绝（root 必须是顶层）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });
    const root = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '顶层', requestKey: 'k0' },
      db,
    );
    const reply = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '回复', replyToCommentId: root.commentId, requestKey: 'k1' },
      db,
    );

    await expectCode(commentsService.listReplies(reply.commentId, { page: 1, page_size: 20 }, db), ErrorCodes.TARGET_UNAVAILABLE);
    await expectCode(commentsService.listReplies(newId(), { page: 1, page_size: 20 }, db), ErrorCodes.TARGET_UNAVAILABLE);
  });

  it('已发布评论读取公开修订正文；未发布评论不出现在公开列表', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });
    const created = await commentsService.createComment(
      caller(author),
      { contentEntityId: reviewId, body: '提交正文', requestKey: 'k' },
      db,
    );

    // 尚未发布 → 公开列表必须看不到（这正是修复掉的泄露点）
    const beforePublish = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(beforePublish.total).toBe(0);
    expect(beforePublish.items).toEqual([]);

    // 发布后才出现在公开列表，且读到的是公开修订正文
    publishComment(db, created.commentId);
    const afterPublish = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(afterPublish.items[0]?.body).toBe('提交正文');

    // 审核通过后把评论指向公开修订
    db.prepare('UPDATE comments SET published_revision_id = ?, latest_submitted_revision_id = ? WHERE id = ?').run(
      created.revisionId,
      created.revisionId,
      created.commentId,
    );

    const published = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(published.items[0]?.publishedRevisionId).toBe(created.revisionId);
    expect(published.items[0]?.body).toBe('提交正文');
  });

  it('数据库层拒绝把 root 指向一条回复（实现之外的兜底仍然有效）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const reviewId = insertReview(db, { authorId: author, pluginId: null });
    const root = insertRootComment(db, { contentEntityId: reviewId, authorId: author });
    const reply1 = insertReply(db, { contentEntityId: reviewId, authorId: author, replyTo: root, root });

    expect(() =>
      insertReply(db, { contentEntityId: reviewId, authorId: author, replyTo: root, root: reply1 }),
    ).toThrow(/必须指向顶层评论|讨论组不一致/);
  });
});
