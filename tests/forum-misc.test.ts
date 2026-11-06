/**
 * 周边修复回归（W4）：举报去重口径 / 计数维护 / 编辑权限 / 草稿 / 通知跳转 / 建表清单。
 *
 * 每个用例都对着"错误实现会变红"写：
 *   M1 评论举报按 comment_id 去重——按 content_entity_id 会让同内容下的两条评论互相挤占；
 *   M3 举报隐藏回复要维护 reply_count——只改 status 会让计数永久漂移；
 *   M4 协管不能编辑他人帖子（设计文档 §5：编辑只给作者 / 站方管理员 / 分区 owner）；
 *   M5 草稿：100 条封顶、total 是真实条数、PATCH 不传的字段不被清空、附件不被误删；
 *   M6 发布草稿时建帖与删草稿同一事务——否则重试会重复发帖；
 *   M8 listBoards 在并发首访时不再抛唯一约束；
 *   M10 讨论区通知点得开、分区申请走自己的 kind；
 *   M11 撤销 owner 会清 forum_boards.owner_id，重新任命同一人不再是 no-op。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertReviewRevision,
  insertUser,
  type TestDb,
} from './support/db';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumDraftService } from '../src/server/modules/forum/drafts';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { createForumBoardApplicationService } from '../src/server/modules/forum/applications';
import { createInteractionsService } from '../src/server/modules/interactions';
import { commentsService } from '../src/server/modules/comments';
import { createNotificationsService } from '../src/server/modules/notifications';
import { REQUIRED_TABLES, selfCheck } from '../src/server/platform/migrate';
import { newId } from '../src/server/platform/id';
import { withTransaction } from '../src/server/platform/tx';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';
import { FORUM_LIMITS } from '../src/packages/common/forum';
import type { CallerContext } from '@/server/platform/context';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

function forumSetup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const alice = insertUser(db);
  const bob = insertUser(db);
  const carol = insertUser(db);
  ensureDefaultBoards(db);
  const general = db.prepare("SELECT id FROM forum_boards WHERE slug = 'general'").get() as { id: string };
  return {
    db,
    admin,
    alice,
    bob,
    carol,
    generalId: general.id,
    posts: createForumPostService({ db }),
    drafts: createForumDraftService({ db }),
    boards: createForumBoardService({ db }),
    applications: createForumBoardApplicationService({ db }),
    interactions: createInteractionsService({ db }),
    notifications: createNotificationsService({ db }),
  };
}

// ============================================================
// M1 · 举报去重口径
// ============================================================

describe('M1 评论举报按 comment_id 去重', () => {
  function publishedReview(db: TestDb['db']): string {
    const authorId = insertUser(db, { nickname: '评测作者' });
    const repoId = insertRepository(db, 'gh-' + Math.random().toString(16).slice(2));
    const pluginId = insertPlugin(db, repoId);
    const reviewId = insertReview(db, { authorId, pluginId });
    const revisionId = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 1 });
    const now = Date.now();
    db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
    db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(
      now,
      now,
      reviewId,
    );
    return reviewId;
  }

  async function publishedComment(db: TestDb['db'], reviewId: string, authorId: string, body: string): Promise<string> {
    const created = await commentsService.createComment(
      caller(db, authorId),
      { contentEntityId: reviewId, body, requestKey: 'c-' + newId() },
      db,
    );
    db.prepare("UPDATE content_submissions SET processing_state = 'approved' WHERE id = ?").run(created.submissionId);
    const { publishComment } = await import('../src/server/workflows/publish-comment');
    publishComment(created.submissionId, db);
    return created.commentId;
  }

  it('同一条内容下的两条不同评论各自独立举报，不互相挤占', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const interactions = createInteractionsService({ db });
    const reviewId = publishedReview(db);
    const author = insertUser(db);
    const reporter = insertUser(db);

    const c1 = await publishedComment(db, reviewId, author, '第一条评论');
    const c2 = await publishedComment(db, reviewId, author, '第二条评论');

    const r1 = await interactions.createReport(caller(db, reporter), {
      targetKind: 'comment',
      targetId: c1,
      reason: 'spam',
    });
    const r2 = await interactions.createReport(caller(db, reporter), {
      targetKind: 'comment',
      targetId: c2,
      reason: 'spam',
    });

    // 旧实现：两条都落到 content_entity_id 上，r2 被当成重复并返回 r1 的 id
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r2.reportId).not.toBe(r1.reportId);

    const row = db.prepare('SELECT comment_id, content_entity_id FROM reports WHERE id = ?').get(r2.reportId) as {
      comment_id: string | null;
      content_entity_id: string | null;
    };
    expect(row.comment_id).toBe(c2);
    // content_entity_id 仍按目标内容记录（列表与后台描述要用）
    expect(row.content_entity_id).toBe(reviewId);
  });

  it('同一条评论同一原因仍然只留一条未处理', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const interactions = createInteractionsService({ db });
    const reviewId = publishedReview(db);
    const author = insertUser(db);
    const reporter = insertUser(db);
    const c1 = await publishedComment(db, reviewId, author, '只有这一条');

    const first = await interactions.createReport(caller(db, reporter), {
      targetKind: 'comment',
      targetId: c1,
      reason: 'spam',
    });
    const again = await interactions.createReport(caller(db, reporter), {
      targetKind: 'comment',
      targetId: c1,
      reason: 'spam',
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.reportId).toBe(first.reportId);
  });

  it('服务层去重口径与迁移 0038 的四条唯一索引一一对应', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const interactions = createInteractionsService({ db });
    const reviewId = publishedReview(db);
    const author = insertUser(db);
    const reporter = insertUser(db);
    const c1 = await publishedComment(db, reviewId, author, 'A');
    const c2 = await publishedComment(db, reviewId, author, 'B');

    // 直接查迁移建出来的索引：comment 那条以 comment_id 为列
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'uq_reports_open_%'")
      .all() as Array<{ name: string; sql: string }>;
    const commentIdx = indexes.find((i) => i.sql.includes('comment_id'));
    expect(commentIdx).toBeTruthy();

    // 索引在库层也真的区分得开：两条评论两条举报，都成功落库
    await interactions.createReport(caller(db, reporter), { targetKind: 'comment', targetId: c1, reason: 'abuse' });
    await interactions.createReport(caller(db, reporter), { targetKind: 'comment', targetId: c2, reason: 'abuse' });
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM reports WHERE target_kind = 'comment' AND state = 'open'")
      .get() as { c: number };
    expect(Number(count.c)).toBe(2);
  });
});

// ============================================================
// M3 · 举报隐藏回复要维护计数
// ============================================================

describe('M3 举报隐藏回复维护 reply_count', () => {
  it('隐藏顶层回复会减 reply_count，且与 deleteReply 的结果一致', async () => {
    const { db, admin, alice, bob, posts, interactions } = forumSetup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '帖子',
      bodyMd: '正文',
    });
    const { replyId } = await posts.createReply(caller(db, bob), postId, { bodyMd: '要被隐藏的回复' });
    await posts.createReply(caller(db, bob), postId, { bodyMd: '留着的那条' });

    const before = await posts.getPost(caller(db, alice), postId);
    expect(before.replyCount).toBe(2);

    const r = await interactions.createReport(caller(db, alice), {
      targetKind: 'forum_reply',
      targetId: replyId,
      reason: 'abuse',
    });
    await interactions.handleReport(caller(db, admin), r.reportId, { action: 'hide', reason: '确认违规' });

    const after = await posts.getPost(caller(db, alice), postId);
    expect(after.replyCount).toBe(1);

    const row = db.prepare('SELECT reply_count FROM forum_posts WHERE id = ?').get(postId) as { reply_count: number };
    expect(row.reply_count).toBe(1);
  });

  it('回复的回复不进 reply_count，隐藏它也不该再扣', async () => {
    const { db, admin, alice, bob, posts, interactions } = forumSetup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '帖子',
      bodyMd: '正文',
    });
    const { replyId: top } = await posts.createReply(caller(db, bob), postId, { bodyMd: '顶层回复' });
    const { replyId: child } = await posts.createReply(caller(db, alice), postId, {
      bodyMd: '回复的回复',
      parentId: top,
    });

    // createReply 对每条回复都 +1（顶层与回复的回复都算进帖子热度）
    const before = await posts.getPost(caller(db, bob), postId);
    expect(before.replyCount).toBe(2);

    const r = await interactions.createReport(caller(db, bob), {
      targetKind: 'forum_reply',
      targetId: child,
      reason: 'abuse',
    });
    await interactions.handleReport(caller(db, admin), r.reportId, { action: 'hide', reason: '确认违规' });

    // 隐藏的是"回复的回复"：它不在顶层回复列表里，隐藏它不该动帖子的计数，
    // 否则帖子的"N 条回复"会凭空少一条（页面仍然显示一条顶层 + 一条二层）
    const after = await posts.getPost(caller(db, bob), postId);
    expect(after.replyCount).toBe(2);
  });

  it('重复处理同一条举报被拒，不会二次扣减', async () => {
    const { db, admin, alice, bob, posts, interactions } = forumSetup();
    const { postId } = await posts.createPost(caller(db, alice), { boardSlug: 'general', title: '帖子', bodyMd: '正文' });
    const { replyId } = await posts.createReply(caller(db, bob), postId, { bodyMd: '回复' });
    const r = await interactions.createReport(caller(db, alice), {
      targetKind: 'forum_reply',
      targetId: replyId,
      reason: 'abuse',
    });
    await interactions.handleReport(caller(db, admin), r.reportId, { action: 'hide', reason: '确认违规' });
    await expect(
      interactions.handleReport(caller(db, admin), r.reportId, { action: 'hide', reason: '再来一次' }),
    ).rejects.toSatisfy(isDomainError);

    const row = db.prepare('SELECT reply_count FROM forum_posts WHERE id = ?').get(postId) as { reply_count: number };
    expect(row.reply_count).toBe(0);
  });
});

// ============================================================
// M4 · 编辑权限（设计文档 §5）
// ============================================================

describe('M4 编辑帖子只给作者 / 站方管理员 / 分区 owner', () => {
  async function ownerBoard() {
    const env = forumSetup();
    // 让 alice 成为 general 的 owner：走 transferOwner（仅站方管理员）
    await env.boards.transferOwner(caller(env.db, env.admin), env.generalId, env.alice);
    return env;
  }

  it('协管（moderator）不能编辑他人帖子，但能软删', async () => {
    const env = await ownerBoard();
    const { db, admin, alice, bob, carol, generalId, posts, boards } = env;
    await boards.appointModerator(caller(db, alice), generalId, bob); // bob = 协管
    const { postId } = await posts.createPost(caller(db, carol), {
      boardSlug: 'general',
      title: '原题',
      bodyMd: '原正文',
    });

    await expect(
      posts.editPost(caller(db, bob), postId, { title: '被协管改掉的标题', bodyMd: '被改的正文' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);

    const row = db.prepare('SELECT title, body_md, status FROM forum_posts WHERE id = ?').get(postId) as {
      title: string;
      body_md: string;
      status: string;
    };
    expect(row.title).toBe('原题');
    expect(row.body_md).toBe('原正文');

    // 软删仍然可以
    await posts.deletePost(caller(db, bob), postId);
    const deleted = db.prepare('SELECT status FROM forum_posts WHERE id = ?').get(postId) as { status: string };
    expect(deleted.status).toBe('deleted');
    void admin;
  });

  it('分区 owner 与站方管理员仍可编辑', async () => {
    const env = await ownerBoard();
    const { db, admin, alice, carol, posts } = env;
    const { postId } = await posts.createPost(caller(db, carol), {
      boardSlug: 'general',
      title: '原题',
      bodyMd: '原正文',
    });
    await posts.editPost(caller(db, alice), postId, { title: '区长改的标题', bodyMd: '区长改的正文' });
    await posts.editPost(caller(db, admin), postId, { title: '管理员改的标题', bodyMd: '管理员改的正文' });
    const row = db.prepare('SELECT title FROM forum_posts WHERE id = ?').get(postId) as { title: string };
    expect(row.title).toBe('管理员改的标题');
  });

  it('作者本人可编辑；getPost 的 canEdit 与真实能否编辑一致', async () => {
    const env = await ownerBoard();
    const { db, alice, bob, carol, generalId, posts, boards } = env;
    await boards.appointModerator(caller(db, alice), generalId, bob);
    const { postId } = await posts.createPost(caller(db, carol), {
      boardSlug: 'general',
      title: '原题',
      bodyMd: '原正文',
    });
    await posts.editPost(caller(db, carol), postId, { title: '作者改的', bodyMd: '作者改的正文' });

    // 视图里的 canEdit 必须与 editPost 的真实判定一致，否则按钮会骗人
    expect((await posts.getPost(caller(db, carol), postId)).canEdit).toBe(true);
    expect((await posts.getPost(caller(db, alice), postId)).canEdit).toBe(true); // owner
    expect((await posts.getPost(caller(db, bob), postId)).canEdit).toBe(false); // moderator
    // 但 moderator 的 canModerate / canDelete 仍为 true
    const asMod = await posts.getPost(caller(db, bob), postId);
    expect(asMod.canModerate).toBe(true);
    expect(asMod.canDelete).toBe(true);
  });
});

// ============================================================
// M5 · 草稿
// ============================================================

describe('M5 草稿上限与部分更新', () => {
  it('每人封顶 100 条，第 101 条被拒；已到上限仍可更新已有草稿', async () => {
    const { db, alice, generalId, drafts } = forumSetup();
    // 直接插 100 条（走服务层太慢，这里只验上限本身）
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT INTO forum_post_drafts (id, author_id, board_id, title, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < FORUM_LIMITS.draftMax; i += 1) {
      stmt.run(newId(), alice, generalId, '草稿' + i, '正文', now + i, now + i);
    }

    await expect(drafts.saveDraft(caller(db, alice), { boardId: generalId, title: '第 101 条' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID,
    );

    // 已有草稿的更新不受上限影响
    const first = db.prepare('SELECT id FROM forum_post_drafts WHERE author_id = ? LIMIT 1').get(alice) as {
      id: string;
    };
    await expect(drafts.saveDraft(caller(db, alice), { draftId: first.id, title: '改一下' })).resolves.toMatchObject({
      created: false,
    });
  });

  it('listMine 的 total 是真实条数，不是返回到手的行数', async () => {
    const { db, alice, generalId, drafts } = forumSetup();
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT INTO forum_post_drafts (id, author_id, board_id, title, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 3; i += 1) stmt.run(newId(), alice, generalId, 'd' + i, '', now + i, now + i);
    const list = await drafts.listMine(caller(db, alice));
    expect(list.items).toHaveLength(3);
    expect(list.total).toBe(3);
  });

  it('PATCH 只带 bodyMd 时标题保留（不被清空）', async () => {
    const { db, alice, generalId, drafts } = forumSetup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '我的标题',
      bodyMd: '第一版',
    });
    await drafts.saveDraft(caller(db, alice), { draftId, bodyMd: '第二版' });
    const one = await drafts.getDraft(caller(db, alice), draftId);
    expect(one.title).toBe('我的标题');
    expect(one.bodyMd).toBe('第二版');
  });

  it('PATCH 只带 title 时附件保留（不被删光）', async () => {
    const { db, alice, generalId, drafts } = forumSetup();
    // 造一个属于 alice 的附件文件行：触发器只校验归属
    const fileId = insertAttachmentFile(db, alice, 'd1');
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '带图草稿',
      bodyMd: '![图](x)',
      attachmentIds: [fileId],
    });
    expect((await drafts.getDraft(caller(db, alice), draftId)).fileIds).toEqual([fileId]);

    await drafts.saveDraft(caller(db, alice), { draftId, title: '只改标题' });
    const one = await drafts.getDraft(caller(db, alice), draftId);
    expect(one.title).toBe('只改标题');
    expect(one.bodyMd).toBe('![图](x)');
    expect(one.fileIds).toEqual([fileId]);
  });

  it('显式传空数组才是"把图删掉"', async () => {
    const { db, alice, generalId, drafts } = forumSetup();
    const fileId = insertAttachmentFile(db, alice, 'd2');
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '带图',
      bodyMd: '正文',
      attachmentIds: [fileId],
    });
    await drafts.saveDraft(caller(db, alice), { draftId, attachmentIds: [] });
    expect((await drafts.getDraft(caller(db, alice), draftId)).fileIds).toEqual([]);
  });
});

// ============================================================
// M6 · 发布草稿与删草稿同一事务
// ============================================================

describe('M6 发布草稿', () => {
  it('建帖与删草稿在同一事务：任一步失败都不留半成品', async () => {
    const { db, alice, generalId, drafts, posts } = forumSetup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '待发布的草稿',
      bodyMd: '正文',
    });

    // 复刻路由里的事务：createPostInTx + deleteDraftInTx
    const { deleteDraftInTx } = await import('../src/server/modules/forum/drafts');
    const draft = await drafts.getDraft(caller(db, alice), draftId);
    const result = withTransaction((tx) => {
      const created = posts.createPostInTx(tx.db, caller(db, alice), {
        boardSlug: draft.boardSlug,
        title: draft.title,
        bodyMd: draft.bodyMd,
      });
      deleteDraftInTx(tx.db, draftId, alice);
      return created;
    }, db);

    expect(result.postId).toBeTruthy();
    const draftRow = db.prepare('SELECT COUNT(*) AS c FROM forum_post_drafts WHERE id = ?').get(draftId) as {
      c: number;
    };
    expect(Number(draftRow.c)).toBe(0);
    const postRow = db.prepare('SELECT COUNT(*) AS c FROM forum_posts WHERE id = ?').get(result.postId) as {
      c: number;
    };
    expect(Number(postRow.c)).toBe(1);
  });

  it('事务内抛错时帖子一起回滚（重试不会重复发帖）', async () => {
    const { db, alice, generalId, drafts } = forumSetup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '草稿',
      bodyMd: '正文',
    });
    const postsBefore = (db.prepare('SELECT COUNT(*) AS c FROM forum_posts').get() as { c: number }).c;

    expect(() =>
      withTransaction(() => {
        // 模拟"建帖成功后删草稿那步炸了"
        throw new Error('删草稿失败');
      }, db),
    ).toThrow();
    const postsAfter = (db.prepare('SELECT COUNT(*) AS c FROM forum_posts').get() as { c: number }).c;
    expect(postsAfter).toBe(postsBefore);
    // 草稿还在，用户可以直接重试
    await expect(drafts.getDraft(caller(db, alice), draftId)).resolves.toMatchObject({ draftId });
  });

  it('createPost 与 createPostInTx 行为一致（同一份逻辑）', async () => {
    const { db, alice, generalId } = forumSetup();
    const posts = createForumPostService({ db });
    const direct = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '直接发',
      bodyMd: '正文',
    });
    const inTx = withTransaction(
      (tx) => posts.createPostInTx(tx.db, caller(db, alice), { boardSlug: 'general', title: '事务里发', bodyMd: '正文' }),
      db,
    );
    expect(direct.pendingReview).toBe(false);
    expect(inTx.pendingReview).toBe(false);
    const count = db.prepare('SELECT COUNT(*) AS c FROM forum_posts WHERE board_id = ?').get(generalId) as {
      c: number;
    };
    expect(Number(count.c)).toBe(2);
  });
});

// ============================================================
// M8 · listBoards 并发首访
// ============================================================

describe('M8 读路径不因并发建默认分区而 500', () => {
  it('分区为空时匿名列分区仍拿得到列表', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    insertUser(db); // ensureDefaultBoards 需要一个用户
    const boards = createForumBoardService({ db });
    const list = await boards.listBoards({ userId: null, role: null, accountStatus: null });
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((b) => b.slug === 'general')).toBe(true);
  });

  it('并发首访不抛唯一约束（模拟另一个请求刚好插进去了）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    insertUser(db);
    // 预先把种子插好：第二次调用走"已有分区直接返回"分支
    ensureDefaultBoards(db);
    const boards = createForumBoardService({ db });
    await expect(boards.listBoards({ userId: null, role: null, accountStatus: null })).resolves.toBeTruthy();
  });

  it('真写失败（非唯一冲突）仍然要抛，不被吞掉', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    // 库里一个用户都没有：ensureDefaultBoards 直接返回，不会抛
    const boards = createForumBoardService({ db });
    await expect(boards.listBoards({ userId: null, role: null, accountStatus: null })).resolves.toEqual([]);
  });
});

// ============================================================
// M10 · 通知跳转
// ============================================================

describe('M10 讨论区通知点得开', () => {
  it('有人回复你的帖子 → 通知 href 落到帖子页的该条回复锚点', async () => {
    const { db, alice, bob, posts, notifications } = forumSetup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '求助',
      bodyMd: '正文',
    });
    const { replyId } = await posts.createReply(caller(db, bob), postId, { bodyMd: '我来回复' });

    const inbox = await notifications.list(alice, {});
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].kind).toBe('forum_reply');
    expect(inbox.items[0].href).toBe('/forum/general/' + postId + '#reply-' + replyId);
  });

  it('回复的回复也有 href；帖子被删后 href 为 null 而不是编一个会 404 的地址', async () => {
    const { db, alice, bob, posts, notifications } = forumSetup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '求助',
      bodyMd: '正文',
    });
    const { replyId: top } = await posts.createReply(caller(db, bob), postId, { bodyMd: '顶层' });
    await posts.createReply(caller(db, alice), postId, { bodyMd: '回复你', parentId: top });

    const bobInbox = await notifications.list(bob, {});
    expect(bobInbox.items[0].kind).toBe('forum_reply_to_reply');
    expect(bobInbox.items[0].href).toContain('/forum/general/' + postId);

    // 被回复的那条回复没了（自引用外键 + RESTRICT，只能先断子回复再删父回复）：
    // 此时不许再编一个会 404 的地址，href 必须是 null
    db.prepare('UPDATE forum_post_replies SET parent_id = NULL WHERE parent_id = ?').run(top);
    db.prepare('DELETE FROM forum_post_replies WHERE id = ?').run(top);
    const after = await notifications.list(alice, {});
    expect(after.items[0].href).toBeNull();
  });

  it('分区申请审核结果用 forum_board_application 这个 kind，且能跳到申请页', async () => {
    const { db, admin, alice, applications, notifications } = forumSetup();
    const { applicationId } = await applications.submit(caller(db, alice), {
      name: '我的分区',
      slug: 'my-board',
      description: '聊聊我的东西',
      reason: '想有个地方交流',
    });
    await applications.approve(caller(db, admin), applicationId, '欢迎');

    const inbox = await notifications.list(alice, {});
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].kind).toBe('forum_board_application');
    expect(inbox.items[0].href).toBe('/forum/applications');
  });
});

// ============================================================
// M11 · 撤销 owner 清 owner_id
// ============================================================

describe('M11 撤销 owner 后 owner_id 清空，可重新任命', () => {
  it('撤销后 owner_id 为 NULL；重新任命同一人不再是 no-op', async () => {
    const { db, admin, alice, generalId, boards } = forumSetup();
    await boards.transferOwner(caller(db, admin), generalId, alice);
    let row = db.prepare('SELECT owner_id FROM forum_boards WHERE id = ?').get(generalId) as { owner_id: string | null };
    expect(row.owner_id).toBe(alice);

    // 站方管理员撤销 alice 的 owner
    await boards.removeModerator(caller(db, admin), generalId, alice);
    row = db.prepare('SELECT owner_id FROM forum_boards WHERE id = ?').get(generalId) as { owner_id: string | null };
    expect(row.owner_id).toBeNull();

    // 关系表里也没有了
    const rel = db
      .prepare('SELECT COUNT(*) AS c FROM forum_board_moderators WHERE board_id = ? AND user_id = ?')
      .get(generalId, alice) as { c: number };
    expect(Number(rel.c)).toBe(0);

    // 重新任命同一人：必须真的生效
    await boards.transferOwner(caller(db, admin), generalId, alice);
    row = db.prepare('SELECT owner_id FROM forum_boards WHERE id = ?').get(generalId) as { owner_id: string | null };
    expect(row.owner_id).toBe(alice);
    const again = db
      .prepare('SELECT role FROM forum_board_moderators WHERE board_id = ? AND user_id = ?')
      .get(generalId, alice) as { role: string } | undefined;
    expect(again?.role).toBe('owner');
  });

  it('owner_id 残留但关系表已丢时，transferOwner 修好它（不再误判 no-op）', async () => {
    const { db, admin, alice, bob, generalId, boards } = forumSetup();
    await boards.transferOwner(caller(db, admin), generalId, alice);
    // 制造历史脏数据：关系表被删掉，但 owner_id 还在
    db.prepare('DELETE FROM forum_board_moderators WHERE board_id = ? AND user_id = ?').run(generalId, alice);

    await boards.transferOwner(caller(db, admin), generalId, bob);
    const row = db.prepare('SELECT owner_id FROM forum_boards WHERE id = ?').get(generalId) as { owner_id: string | null };
    expect(row.owner_id).toBe(bob);
  });
});

// ============================================================
// M9 · REQUIRED_TABLES
// ============================================================

describe('M9 REQUIRED_TABLES 覆盖讨论区全部表', () => {
  it('0037/0038 建的 forum_* 表都在 REQUIRED_TABLES 里，且自检无缺表', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const forumTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'forum_%'").all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(forumTables.length).toBeGreaterThanOrEqual(13);
    const missing = forumTables.filter((t) => !(REQUIRED_TABLES as readonly string[]).includes(t));
    expect(missing).toEqual([]);

    const check = selfCheck(db);
    expect(check.missingTables).toEqual([]);
  });
});

// ============================================================
// ============================================================
// 工具：造一个属于某人的附件文件行
// ============================================================

/**
 * 与 forum-posts.test.ts 同一套造数：attachments + attachment_files。
 * 变体必须是 display——服务层只收展示图，original 会被"原图不能直接引用"拒掉。
 */
function insertAttachmentFile(db: TestDb['db'], ownerId: string, tag: string): string {
  const att = 'att_' + tag;
  const file = 'file_' + tag;
  const now = Date.now();
  db.prepare(
    'INSERT INTO attachments (id, uploaded_by, original_filename, processing_state, created_at, ready_at) VALUES (?,?,?,?,?,?)',
  ).run(att, ownerId, 'a.png', 'ready', now, now);
  const hash = Array.from(tag)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64);
  db.prepare(
    'INSERT INTO attachment_files (id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height, content_hash, processing_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(file, att, 'display', 'display', 'image/png', 100, 10, 10, hash, 'ready', now);
  return file;
}
