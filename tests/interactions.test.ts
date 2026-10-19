/**
 * 互动三件套：有帮助 / 收藏 / 举报（`idea.md §13`、§15、§20、§23）。
 *
 * 这些用例都对着"错误实现会变红"写：
 *  - 有帮助必须是**一人一票 + 可取消**（重复插入会撞主键、只加不减会红）；
 *  - 收藏必须幂等切换，并拒绝不存在的目标；
 *  - 举报必须**去重**（同一人同目标同原因只留一条未处理的）、只允许对公开内容举报；
 *  - 举报处理必须真的隐藏内容、写处理记录、发结果通知，且重复处理要拒绝；
 *  - 管理员隐藏的评论**整条不展示**（与作者删除的占位语义不同）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertReview, insertReviewRevision, insertUser, type TestDb } from './support/db';
import { createInteractionsService } from '../src/server/modules/interactions';
import { commentsService } from '../src/server/modules/comments';
import { createNotificationsService } from '../src/server/modules/notifications';
import { resolveVisibilityInTx } from '../src/server/modules/content';
import { newId } from '../src/server/platform/id';
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

/** 造一篇**已公开**的评测，返回 { reviewId, authorId }。 */
function publishedReview(db: TestDb['db']): { reviewId: string; authorId: string } {
  const authorId = insertUser(db, { nickname: '评测作者' });
  const repoId = insertRepository(db, `gh-${Math.random().toString(16).slice(2)}`);
  const pluginId = insertPlugin(db, repoId);
  const reviewId = insertReview(db, { authorId, pluginId });
  const revisionId = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 1, title: '一篇公开评测' });
  const now = Date.now();
  db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
  db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(
    now,
    now,
    reviewId,
  );
  return { reviewId, authorId };
}

/** 造一条**已公开**的顶层评论，返回 commentId。 */
async function publishedComment(db: TestDb['db'], reviewId: string, authorId: string): Promise<string> {
  const created = await commentsService.createComment(
    caller(db, authorId),
    { contentEntityId: reviewId, body: '这是一条会被举报的评论', requestKey: `c-${newId()}` },
    db,
  );
  db.prepare("UPDATE content_submissions SET processing_state = 'approved' WHERE id = ?").run(created.submissionId);
  const { publishComment } = await import('../src/server/workflows/publish-comment');
  publishComment(created.submissionId, db);
  return created.commentId;
}

describe('有帮助', () => {
  it('一人一票、可取消；匿名不能投票', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const { reviewId } = publishedReview(db);
    const user = insertUser(db, { nickname: '读者' });

    expect(await service.helpfulState(reviewId, user)).toEqual({ helpful: false, count: 0 });

    const on = await service.toggleHelpful(caller(db, user), reviewId);
    expect(on).toEqual({ helpful: true, count: 1 });
    // 再点一次 = 取消（不是再加一票）
    const off = await service.toggleHelpful(caller(db, user), reviewId);
    expect(off).toEqual({ helpful: false, count: 0 });

    await expect(
      service.toggleHelpful({ userId: null, role: null, accountStatus: null }, reviewId),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('两个人各一票；未公开的评测不能投票', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const { reviewId } = publishedReview(db);
    const u1 = insertUser(db, { nickname: '甲' });
    const u2 = insertUser(db, { nickname: '乙' });

    await service.toggleHelpful(caller(db, u1), reviewId);
    const both = await service.toggleHelpful(caller(db, u2), reviewId);
    expect(both.count).toBe(2);
    expect((await service.helpfulCounts([reviewId]))!.get(reviewId)).toBe(2);

    // 造一篇未公开的评测：不能投票
    const authorId = insertUser(db, { nickname: '草稿作者' });
    const hiddenReview = insertReview(db, { authorId, pluginId: null });
    await expect(service.toggleHelpful(caller(db, u1), hiddenReview)).rejects.toMatchObject({
      code: 'target_unavailable',
    });
  });
});

describe('收藏', () => {
  it('切换收藏、列出收藏；不存在的插件与 pack 被拒', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const user = insertUser(db, { nickname: '收藏者' });
    const repoId = insertRepository(db, 'gh-fav-1');
    const pluginId = insertPlugin(db, repoId, '.');

    expect(await service.toggleFavorite(caller(db, user), { kind: 'plugin', targetId: pluginId })).toEqual({
      favorited: true,
    });
    expect(await service.isFavorite(caller(db, user), pluginId)).toBe(true);
    const list = await service.listFavoritePlugins(caller(db, user));
    expect(list).toHaveLength(1);
    expect(list[0]!.pluginId).toBe(pluginId);
    expect(list[0]!.repositoryFullName).toBeTruthy();

    expect(await service.toggleFavorite(caller(db, user), { kind: 'plugin', targetId: pluginId })).toEqual({
      favorited: false,
    });
    expect(await service.listFavoritePlugins(caller(db, user))).toHaveLength(0);

    await expect(
      service.toggleFavorite(caller(db, user), { kind: 'plugin', targetId: newId() }),
    ).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(
      service.toggleFavorite(caller(db, user), { kind: 'pack', targetId: newId() }),
    ).rejects.toMatchObject({ code: 'input_invalid' });
  });
});

describe('举报', () => {
  it('举报公开评测；同一人同目标同原因只留一条未处理', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const { reviewId } = publishedReview(db);
    const reporter = insertUser(db, { nickname: '举报人' });

    const first = await service.createReport(caller(db, reporter), {
      targetKind: 'review',
      targetId: reviewId,
      reason: 'misinformation',
      detail: '实测结论与日志不符',
    });
    expect(first.created).toBe(true);

    const again = await service.createReport(caller(db, reporter), {
      targetKind: 'review',
      targetId: reviewId,
      reason: 'misinformation',
      detail: '再提一次',
    });
    expect(again.created).toBe(false);
    expect(again.reportId).toBe(first.reportId);

    // 换一个原因 = 另一条（不同问题可以分开举报）
    const other = await service.createReport(caller(db, reporter), {
      targetKind: 'review',
      targetId: reviewId,
      reason: 'spam',
    });
    expect(other.created).toBe(true);
  });

  it('未公开的评测、未知原因、匿名都不能举报', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const authorId = insertUser(db, { nickname: '作者' });
    const draftReview = insertReview(db, { authorId, pluginId: null });
    const reporter = insertUser(db, { nickname: '举报人' });

    await expect(
      service.createReport(caller(db, reporter), { targetKind: 'review', targetId: draftReview, reason: 'spam' }),
    ).rejects.toMatchObject({ code: 'target_unavailable' });

    await expect(
      service.createReport(caller(db, reporter), {
        targetKind: 'review',
        targetId: draftReview,
        reason: 'not-a-reason' as never,
      }),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createReport({ userId: null, role: null, accountStatus: null }, {
        targetKind: 'review',
        targetId: draftReview,
        reason: 'spam',
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('处理举报：隐藏评测 + 写处理记录 + 通知举报人与作者；重复处理被拒', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const { reviewId, authorId } = publishedReview(db);
    const reporter = insertUser(db, { nickname: '举报人' });
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });

    const report = await service.createReport(caller(db, reporter), {
      targetKind: 'review',
      targetId: reviewId,
      reason: 'abuse',
      detail: '含人身攻击',
    });

    // 处理前：待办里能看到
    const queue = await service.listReports(caller(db, admin), { state: 'open' });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.targetExcerpt).toContain('一篇公开评测');
    expect(queue[0]!.targetHref).toBe(`/reviews/${reviewId}`);

    const handled = await service.handleReport(caller(db, admin), report.reportId, {
      action: 'hide',
      reason: '确认存在人身攻击',
    });
    expect(handled.state).toBe('resolved');
    expect(handled.notified).toBe(2); // 举报人 + 作者

    // 内容真的被隐藏了
    expect(resolveVisibilityInTx(db, reviewId).hidden).toBe(true);
    expect(resolveVisibilityInTx(db, reviewId).publiclyVisible).toBe(false);

    // 处理记录
    const record = db
      .prepare('SELECT action, reason, handled_by FROM report_handling_records WHERE report_id = ?')
      .get(report.reportId) as { action: string; reason: string; handled_by: string };
    expect(record).toMatchObject({ action: 'hide', reason: '确认存在人身攻击', handled_by: admin });

    // 通知：举报人与作者各一条，且不会重复
    const reporterInbox = await createNotificationsService({ db }).list(reporter, {});
    const authorInbox = await createNotificationsService({ db }).list(authorId, {});
    expect(reporterInbox.items).toHaveLength(1);
    expect(reporterInbox.items[0]!.kind).toBe('moderation_result');
    expect(reporterInbox.items[0]!.excerpt).toContain('已隐藏');
    expect(authorInbox.items).toHaveLength(1);

    // 重复处理 → 冲突
    await expect(
      service.handleReport(caller(db, admin), report.reportId, { action: 'dismiss', reason: '再处理一次' }),
    ).rejects.toMatchObject({ code: 'version_conflict' });

    // 非管理员不能处理
    await expect(
      service.handleReport(caller(db, reporter), report.reportId, { action: 'dismiss', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('驳回：不改内容、状态 dismissed、通知只给举报人', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const { reviewId, authorId } = publishedReview(db);
    const reporter = insertUser(db, { nickname: '举报人' });
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });

    const report = await service.createReport(caller(db, reporter), {
      targetKind: 'review',
      targetId: reviewId,
      reason: 'other',
      detail: '感觉不对',
    });
    const handled = await service.handleReport(caller(db, admin), report.reportId, {
      action: 'dismiss',
      reason: '未发现违规',
    });
    expect(handled.state).toBe('dismissed');
    expect(handled.notified).toBe(1);
    expect(resolveVisibilityInTx(db, reviewId).hidden).toBe(false);
    expect((await createNotificationsService({ db }).list(authorId, {})).items).toHaveLength(0);
  });

  it('隐藏评论：整条从公开讨论里消失（与作者删除的占位不同）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createInteractionsService({ db });
    const { reviewId, authorId } = publishedReview(db);
    const commenter = insertUser(db, { nickname: '评论者' });
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const commentId = await publishedComment(db, reviewId, commenter);

    const pageBefore = await commentsService.listRootComments(reviewId, { page: 1, page_size: 10 }, db);
    expect(pageBefore.items).toHaveLength(1);

    const report = await service.createReport(caller(db, authorId), {
      targetKind: 'comment',
      targetId: commentId,
      reason: 'abuse',
    });
    const handled = await service.handleReport(caller(db, admin), report.reportId, {
      action: 'hide',
      reason: '确实违规',
    });
    expect(handled.state).toBe('resolved');

    const pageAfter = await commentsService.listRootComments(reviewId, { page: 1, page_size: 10 }, db);
    expect(pageAfter.items).toHaveLength(0);
    expect(pageAfter.total).toBe(0);
  });
});
