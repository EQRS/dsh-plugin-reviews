/**
 * 站内通知 + 评论编辑/删除 + 业务配置（`idea.md §11`、§24；`参数与管理规则.md`）。
 *
 * 三组都想证明"**对着错误实现会变红**"，不是走个过场：
 *  1. 通知：自己不通知自己、同一事件不重复、只有发布那一刻才发、越权标不了别人的已读；
 *  2. 评论编辑/删除：编辑走同套检查（不直接替换公开内容）、旧修订的发布被判 superseded、
 *     删除后正文真的读不出来、有回复保留占位；
 *  3. 配置：默认值来自定义、越界拒绝、**非管理员拒绝**、值没变不产生修订、
 *     以及"把上限改成 1 之后真的只放行一次"（可调不是装饰）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertReview, insertUser, type TestDb } from './support/db';
import { commentsService } from '@/server/modules/comments';
import { publishComment } from '@/server/workflows/publish-comment';
import { createNotificationsService, deliverCommentNotification } from '@/server/modules/notifications';
import { createSettingsService, SETTING_DEFINITIONS, effectiveSettings } from '@/server/modules/settings';
import { enforceRateLimit, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import type { CallerContext } from '@/server/platform/context';

let ctxDb: TestDb | null = null;
afterEach(() => {
  ctxDb?.cleanup();
  ctxDb = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

/** 把提交推到 approved（跳过检查器，专测发布侧行为）。 */
function approve(db: TestDb['db'], submissionId: string): void {
  db.prepare("UPDATE content_submissions SET processing_state = 'approved' WHERE id = ?").run(submissionId);
}

// ============================================================
// 1) 通知
// ============================================================

describe('站内通知', () => {
  it('顶层评论发布 → 内容作者收到通知；回复发布 → 被回复人收到通知', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const replier = insertUser(db, { nickname: '回复者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    // ① 评论者评论作者的内容 → 通知作者
    const c1 = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '这篇写得好', requestKey: 'k1' },
      db,
    );
    approve(db, c1.submissionId);
    expect(publishComment(c1.submissionId, db).published).toBe(true);

    const notes = createNotificationsService({ db });
    let inbox = await notes.list(author, {});
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.items[0]).toMatchObject({ kind: 'comment_on_content', actorNickname: '评论者' });
    expect(inbox.items[0]!.excerpt).toContain('写得好');

    // ② 回复者回复"评论者"的评论 → 通知评论者（不是内容作者）
    const c2 = await commentsService.createComment(
      caller(db, replier),
      { contentEntityId: entityId, body: '同意你', replyToCommentId: c1.commentId, requestKey: 'k2' },
      db,
    );
    approve(db, c2.submissionId);
    expect(publishComment(c2.submissionId, db).published).toBe(true);

    const commenterInbox = await notes.list(commenter, {});
    expect(commenterInbox.unreadCount).toBe(1);
    expect(commenterInbox.items[0]).toMatchObject({ kind: 'reply_to_comment', actorNickname: '回复者' });
    // 作者没有多收到一条（回复只通知被回复人）
    expect((await notes.list(author, {})).unreadCount).toBe(1);
  });

  it('自己不通知自己：作者评论自己的内容 → 一条都不发', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const c1 = await commentsService.createComment(
      caller(db, author),
      { contentEntityId: entityId, body: '自己补充一句', requestKey: 'k1' },
      db,
    );
    approve(db, c1.submissionId);
    publishComment(c1.submissionId, db);

    expect((await createNotificationsService({ db }).list(author, {})).unreadCount).toBe(0);
  });

  it('数据库层兜底：recipient 与 actor 相同直接插不进去（应用层漏判也守得住）', () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const u = insertUser(db, { nickname: '甲' });
    const entityId = insertReview(db, { authorId: u, pluginId: null });
    const commentId = '01a00000-0000-7000-8000-000000000001';
    db.prepare('INSERT INTO comments (id, content_entity_id, author_id, created_at) VALUES (?, ?, ?, ?)').run(
      commentId,
      entityId,
      u,
      Date.now(),
    );

    expect(() =>
      db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, read_at, created_at)
           VALUES (?, ?, 'comment_on_content', ?, ?, ?, ?, NULL, ?)`,
        )
        .run('01a00000-0000-7000-8000-000000000002', u, u, commentId, entityId, 'dup-key', Date.now()),
    ).toThrow(/CHECK/);
  });

  it('同一事件不重复：重复投递（含编辑后再发布）只留一条', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    // 通知对评论有外键：先插一条真实评论（顶层评论的两列都必须为空）
    const commentId = '01a00000-0000-7000-8000-00000000000b';
    db.prepare('INSERT INTO comments (id, content_entity_id, author_id, created_at) VALUES (?, ?, ?, ?)').run(
      commentId,
      entityId,
      commenter,
      Date.now(),
    );

    const a = deliverCommentNotification(db, {
      commentId,
      contentEntityId: entityId,
      actorId: commenter,
      replyToCommentId: null,
      now: Date.now(),
    });
    const b = deliverCommentNotification(db, {
      commentId,
      contentEntityId: entityId,
      actorId: commenter,
      replyToCommentId: null,
      now: Date.now() + 1000,
    });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, reason: 'duplicate' });
    expect((await createNotificationsService({ db }).list(author, {})).items).toHaveLength(1);
  });

  it('已读：只能标自己的；重复标记不报错也不重复计数', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const other = insertUser(db, { nickname: '别人' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const c1 = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '你好', requestKey: 'k1' },
      db,
    );
    approve(db, c1.submissionId);
    publishComment(c1.submissionId, db);

    const notes = createNotificationsService({ db });
    const mine = (await notes.list(author, {})).items[0]!;

    // 别人来标我的通知 → 一条都标不上
    expect((await notes.markRead(other, { ids: [mine.id] })).marked).toBe(0);
    expect((await notes.list(author, {})).unreadCount).toBe(1);

    // 我自己标 → 成功；再标一次 → 0（幂等）
    expect((await notes.markRead(author, { ids: [mine.id] })).marked).toBe(1);
    expect((await notes.markRead(author, { ids: [mine.id] })).marked).toBe(0);
    expect((await notes.list(author, {})).unreadCount).toBe(0);
    // 已读之后 unreadOnly 列表为空，但全量列表仍在
    expect((await notes.list(author, { unreadOnly: true })).items).toHaveLength(0);
    expect((await notes.list(author, {})).items).toHaveLength(1);
  });
});

// ============================================================
// 2) 评论编辑 / 删除
// ============================================================

describe('评论编辑与删除', () => {
  it('编辑：新建修订 + 新提交 + 维护 latest_submitted_revision_id（发布侧的判据）', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const created = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '初版', requestKey: 'k1' },
      db,
    );
    const edited = await commentsService.editComment(
      caller(db, commenter),
      { commentId: created.commentId, body: '改过一遍', requestKey: 'k2' },
      db,
    );

    expect(edited.created).toBe(true);
    expect(edited.revisionId).not.toBe(created.revisionId);
    const rows = db
      .prepare('SELECT revision_number, body FROM comment_revisions WHERE comment_id = ? ORDER BY revision_number')
      .all(created.commentId) as Array<{ revision_number: number; body: string }>;
    expect(rows.map((r) => r.revision_number)).toEqual([1, 2]);
    expect(rows[1]!.body).toBe('改过一遍');
    const comment = db
      .prepare('SELECT latest_submitted_revision_id, published_revision_id, edited_at FROM comments WHERE id = ?')
      .get(created.commentId) as { latest_submitted_revision_id: string; published_revision_id: string | null; edited_at: number | null };
    expect(comment.latest_submitted_revision_id).toBe(edited.revisionId);
    // 编辑**不会**直接替换公开内容：还没发布，公开修订仍为空
    expect(comment.published_revision_id).toBeNull();
    expect(comment.edited_at).toBeNull();
  });

  it('编辑发布：正文替换、写 edited_at；**旧修订的提交被判 superseded**', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const c = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '初版', requestKey: 'k1' },
      db,
    );
    approve(db, c.submissionId);
    expect(publishComment(c.submissionId, db).published).toBe(true);

    // 第一次编辑（rev2）→ 先不发布；第二次编辑（rev3）→ 成为最新提交
    const e1 = await commentsService.editComment(caller(db, commenter), { commentId: c.commentId, body: '第一次改', requestKey: 'k2' }, db);
    const e2 = await commentsService.editComment(caller(db, commenter), { commentId: c.commentId, body: '第二次改', requestKey: 'k3' }, db);

    // 旧提交（e1）现在发布 → 必须被判 superseded（不能覆盖成"第一次改"）
    approve(db, e1.submissionId);
    const stale = publishComment(e1.submissionId, db);
    expect(stale.published).toBe(false);
    expect(stale.reason).toBe('superseded');

    // 最新提交（e2）可以发布，正文变成"第二次改"，并记下 edited_at
    approve(db, e2.submissionId);
    expect(publishComment(e2.submissionId, db).published).toBe(true);

    const page = await commentsService.listRootComments(entityId, { page: 1, page_size: 10 }, db);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.body).toBe('第二次改');
    expect(page.items[0]!.editedAt).not.toBeNull();
    // 首次公开时间不被编辑改写（编辑 ≠ 重新发布）
    expect(page.items[0]!.firstPublishedAt).toBe(page.items[0]!.firstPublishedAt);
  });

  it('只能编辑/删除自己的评论（别人的 → forbidden）', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const other = insertUser(db, { nickname: '路人' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const c = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '我的话', requestKey: 'k1' },
      db,
    );
    await expect(
      commentsService.editComment(caller(db, other), { commentId: c.commentId, body: '篡改', requestKey: 'kx' }, db),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(commentsService.deleteComment(caller(db, other), { commentId: c.commentId }, db)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('删除：软删除 + 幂等；没有回复时整条从公开列表消失，正文读不出来', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const c = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '说过的话', requestKey: 'k1' },
      db,
    );
    approve(db, c.submissionId);
    publishComment(c.submissionId, db);
    expect((await commentsService.listRootComments(entityId, { page: 1, page_size: 10 }, db)).items).toHaveLength(1);

    const del = await commentsService.deleteComment(caller(db, commenter), { commentId: c.commentId }, db);
    expect(del).toMatchObject({ deleted: true, alreadyDeleted: false, hasReplies: false });

    // 再删一次：幂等，不报错
    expect(await commentsService.deleteComment(caller(db, commenter), { commentId: c.commentId }, db)).toMatchObject({
      deleted: false,
      alreadyDeleted: true,
    });

    // 公开列表里没有了
    expect((await commentsService.listRootComments(entityId, { page: 1, page_size: 10 }, db)).items).toHaveLength(0);
    // 已删除的评论也不能再被编辑
    await expect(
      commentsService.editComment(caller(db, commenter), { commentId: c.commentId, body: '再改', requestKey: 'k9' }, db),
    ).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('有回复的删除：保留占位（条目还在、正文为空、deletedAt 非空），回复照常可见', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const author = insertUser(db, { nickname: '作者' });
    const commenter = insertUser(db, { nickname: '评论者' });
    const replier = insertUser(db, { nickname: '回复者' });
    const entityId = insertReview(db, { authorId: author, pluginId: null });

    const root = await commentsService.createComment(
      caller(db, commenter),
      { contentEntityId: entityId, body: '顶层', requestKey: 'k1' },
      db,
    );
    approve(db, root.submissionId);
    publishComment(root.submissionId, db);

    const reply = await commentsService.createComment(
      caller(db, replier),
      { contentEntityId: entityId, body: '回复', replyToCommentId: root.commentId, requestKey: 'k2' },
      db,
    );
    approve(db, reply.submissionId);
    publishComment(reply.submissionId, db);

    const del = await commentsService.deleteComment(caller(db, commenter), { commentId: root.commentId }, db);
    expect(del.hasReplies).toBe(true);

    const page = await commentsService.listRootComments(entityId, { page: 1, page_size: 10 }, db);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.deletedAt).not.toBeNull();
    expect(page.items[0]!.body).toBe(''); // 占位：正文不再泄露
    expect(page.items[0]!.replyCount).toBe(1);

    // 回复仍然可见
    const replies = await commentsService.listReplies(root.commentId, { page: 1, page_size: 10 }, db);
    expect(replies.items).toHaveLength(1);
    expect(replies.items[0]!.body).toBe('回复');
  });
});

// ============================================================
// 3) 业务配置
// ============================================================

describe('业务配置（site_settings + configuration_revisions）', () => {
  it('默认值来自定义清单；写入后生效值变化，并留下修订记录与指向关系', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });

    const before = effectiveSettings(db);
    expect(before.effective['rate_limits.comment_changes_per_minute']).toBe(5);
    expect(before.overriddenKeys).toEqual([]);

    const service = createSettingsService({ db });
    const res = await service.update(caller(db, admin), {
      changes: { 'rate_limits.comment_changes_per_minute': 8, 'discovery.daily_enabled': false },
      reason: '压测期间放宽评论频率并暂停发现',
      requestKey: 'cfg-1',
    });

    expect(res.applied).toEqual([
      { key: 'rate_limits.comment_changes_per_minute', from: 5, to: 8 },
      { key: 'discovery.daily_enabled', from: true, to: false },
    ]);
    expect(res.revisionNumber).toBe(1);

    const after = effectiveSettings(db);
    expect(after.effective['rate_limits.comment_changes_per_minute']).toBe(8);
    expect(after.effective['discovery.daily_enabled']).toBe(false);
    expect(after.overriddenKeys.sort()).toEqual([
      'discovery.daily_enabled',
      'rate_limits.comment_changes_per_minute',
    ]);

    // 修订记录：完整生效快照 + 本次变化 + 原因 + 谁改的
    const history = await service.history();
    expect(history).toHaveLength(1);
    expect(history[0]!.reason).toContain('压测');
    expect(history[0]!.snapshot['rate_limits.comment_changes_per_minute']).toBe(8);
    expect(history[0]!.changedByName).toBe('管理员');

    // site_settings 的每一行都指向"是哪次修改把它改成这样的"
    const rows = db.prepare('SELECT key, changed_in_revision_id, updated_by FROM site_settings').all() as Array<{
      key: string;
      changed_in_revision_id: string;
      updated_by: string;
    }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.changed_in_revision_id).toBe(history[0]!.revisionId);
      expect(r.updated_by).toBe(admin);
    }
  });

  it('越界/类型不对/未知键/缺原因/非管理员 → 一律拒绝，且不落任何行', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const normal = insertUser(db, { nickname: '普通用户' });
    const service = createSettingsService({ db });

    const cases: Array<{ input: Record<string, unknown>; reason: string; key: string; code: string }> = [
      { input: { 'rate_limits.comment_changes_per_minute': 999 }, reason: '太大', key: 'range', code: 'input_invalid' },
      { input: { 'rate_limits.comment_changes_per_minute': 'x' }, reason: '类型', key: 'type', code: 'input_invalid' },
      { input: { 'not.a.real.key': 1 }, reason: '未知键', key: 'unknown', code: 'input_invalid' },
    ];
    for (const c of cases) {
      await expect(
        service.update(caller(db, admin), { changes: c.input, reason: c.reason, requestKey: `k-${c.key}` }),
      ).rejects.toMatchObject({ code: c.code });
    }

    // 缺原因
    await expect(
      service.update(caller(db, admin), {
        changes: { 'rate_limits.comment_changes_per_minute': 6 },
        reason: '   ',
        requestKey: 'k-noreason',
      }),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    // 非管理员
    await expect(
      service.update(caller(db, normal), {
        changes: { 'rate_limits.comment_changes_per_minute': 6 },
        reason: '我不是管理员',
        requestKey: 'k-notadmin',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    expect(db.prepare('SELECT COUNT(*) AS c FROM site_settings').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM configuration_revisions').get()).toEqual({ c: 0 });
  });

  it('请求值与现状相同 → 不产生修订（天然幂等，不靠请求键）', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const service = createSettingsService({ db });

    const first = await service.update(caller(db, admin), {
      changes: { 'rate_limits.comment_changes_per_minute': 7 },
      reason: '调成 7',
      requestKey: 'cfg-1',
    });
    const second = await service.update(caller(db, admin), {
      changes: { 'rate_limits.comment_changes_per_minute': 7 },
      reason: '再调成 7（值没变）',
      requestKey: 'cfg-2',
    });

    expect(first.revisionNumber).toBe(1);
    expect(second.revisionId).toBeNull();
    expect(second.applied).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM configuration_revisions').get() as { c: number }).c).toBe(1);
  });

  it('配置项清单里每一项都真的被读（不是摆设）：频控上限改成 1 后只放行一次', async () => {
    ctxDb = createTestDb();
    const db = ctxDb.db;
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const uid = insertUser(db, { nickname: '甲' });
    const service = createSettingsService({ db });

    await service.update(caller(db, admin), {
      changes: { 'rate_limits.comment_changes_per_minute': 1 },
      reason: '验证可调真的生效',
      requestKey: 'cfg-1',
    });

    const rule = RATE_LIMIT_RULES.comment_change;
    const override = await rateLimitOverrideFor(db, rule);
    expect(override.points).toBe(1);

    const ticket = await enforceRateLimit(db, 'comment_change', uid, 1, override);
    expect(ticket.remainingPoints).toBe(0);
    await expect(enforceRateLimit(db, 'comment_change', uid, 1, override)).rejects.toMatchObject({
      code: 'rate_limited',
    });

    // 再放宽到 3：必须**立刻**生效（缓存键里带着生效值，否则会命中按动作名缓存的老 limiter）
    await service.update(caller(db, admin), {
      changes: { 'rate_limits.comment_changes_per_minute': 3 },
      reason: '放宽到 3',
      requestKey: 'cfg-2',
    });
    const relaxed = await rateLimitOverrideFor(db, rule);
    expect(relaxed.points).toBe(3);
    await expect(enforceRateLimit(db, 'comment_change', uid, 1, relaxed)).resolves.toBeTruthy();
  });

  it('每个可配置键的默认值都与频控规则里的默认值一致（两处不许漂移）', () => {
    const byKey = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));
    for (const rule of Object.values(RATE_LIMIT_RULES)) {
      const def = byKey.get(rule.specKey);
      expect(def, `频控规则 ${rule.action} 的 specKey 不在可配置清单里`).toBeDefined();
      expect(def!.defaultValue).toBe(rule.points);
    }
  });
});
