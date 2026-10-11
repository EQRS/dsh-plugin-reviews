/**
 * 评论公开可见性回归测试。
 *
 * 背景：这是**真实抓到并修掉**的缺陷 ——
 * `listRootComments` / `listReplies` / `countReplies` 起初没有按
 * `published_revision_id IS NOT NULL` 过滤，导致**尚未通过检查的新评论**
 * 会出现在公开列表里（违架构第 78.2、79.2 节）。
 *
 * 本文件的用例在该缺陷复现时必须变红。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createTestDb, insertRootComment, type TestDb } from './support/db';
import { commentsService } from '../src/server/modules/comments';
import { createIdentityService } from '../src/server/modules/identity';
import { reviewsService } from '../src/server/modules/reviews';
import { createCatalogService, type CatalogProbe } from '../src/server/modules/catalog';
import { newId } from '../src/server/platform/id';
import type { CallerContext } from '../src/server/platform/context';

let h: TestDb;
let db: TestDb['db'];

beforeEach(() => {
  h = createTestDb();
  db = h.db;
});
afterEach(() => h.cleanup());

function caller(userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

function probe(): CatalogProbe {
  return {
    async fetchRepository() {
      return { githubRepositoryId: 'gh-1', fullName: 'a/b', htmlUrl: 'https://github.com/a/b', isArchived: false };
    },
    async fetchPluginManifest() {
      return { bundlePath: './x.json', bundleExists: true };
    },
  };
}

/** 建一个用户 + 一篇已公开的评测，返回 { ctx, reviewId }。 */
async function setupPublishedReview() {
  const identity = createIdentityService({ db });
  const signIn = await identity.signInWithGithub(
    {
      providerUserId: `gh-${newId()}`,
      providerUsername: 'author',
      profileUrl: 'https://github.com/author',
      avatarUrl: null,
      displayName: 'author',
    },
    Date.now(),
  );
  const ctx = caller(signIn.userId);

  const catalog = createCatalogService({ db });
  const plugin = await catalog.acceptPluginSubmission(
    ctx,
    { url: 'https://github.com/a/b', requestKey: `pk-${newId()}` },
    { probe: probe() },
  );

  const draft = await reviewsService.createOrGetDraft(ctx, { pluginId: plugin.pluginId, requestKey: `dk-${newId()}` }, db);
  const saved = await reviewsService.saveDraft(
    ctx,
    {
      draftId: draft.draftId,
      expectedVersion: 0,
      requestKey: `sk-${newId()}`,
      payload: {
        title: '一篇公开评测',
        pluginId: plugin.pluginId,
        pluginVersion: { kind: 'unknown' },
        dshVersion: { kind: 'unknown' },
        body: [{ key: 's1', markdown: '正文' }],
      },
    },
    db,
  );

  // 直接把文章标为已公开（本测试关注评论可见性，不重复走完整发布链）
  const revId = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO review_revisions (id, review_id, revision_number, plugin_id, title, body_markdown, plugin_version, dsh_version, submitted_at)
     VALUES (?, ?, 1, ?, '一篇公开评测', '正文', '{"kind":"unknown"}', '{"kind":"unknown"}', ?)`,
  ).run(revId, draft.reviewId, plugin.pluginId, now);
  db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revId, draft.reviewId);
  db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(now, now, draft.reviewId);

  return { ctx, reviewId: draft.reviewId, saved };
}

describe('评论公开可见性（回归：未公开评论绝不能出现在公开列表）', () => {
  it('刚创建但未发布的新评论不出现在公开列表，且 total 为 0', async () => {
    const { ctx, reviewId } = await setupPublishedReview();

    const created = await commentsService.createComment(
      ctx,
      { contentEntityId: reviewId, body: '这条还没通过检查', requestKey: `ck-${newId()}` },
      db,
    );
    expect(created.commentId).toBeTruthy();

    // 库里确实有这条评论，但没有公开修订
    const row = db
      .prepare('SELECT published_revision_id FROM comments WHERE id = ?')
      .get(created.commentId) as { published_revision_id: string | null };
    expect(row.published_revision_id).toBeNull();

    // 公开列表必须看不到它 —— 这正是修复前会失败的地方
    const visible = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(visible.total).toBe(0);
    expect(visible.items).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain('还没通过检查');
  });

  it('发布后（切公开修订）才出现，且 total 随之变化', async () => {
    const { ctx, reviewId } = await setupPublishedReview();

    const created = await commentsService.createComment(
      ctx,
      { contentEntityId: reviewId, body: '通过后才可见的评论', requestKey: `ck-${newId()}` },
      db,
    );

    // 发布：切公开修订 + 记首次公开时间
    const now = Date.now();
    const revRow = db
      .prepare('SELECT id FROM comment_revisions WHERE comment_id = ?')
      .get(created.commentId) as { id: string };
    db.prepare('UPDATE comments SET published_revision_id = ?, first_published_at = ? WHERE id = ?').run(
      revRow.id,
      now,
      created.commentId,
    );

    const visible = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(visible.total).toBe(1);
    expect(visible.items[0]?.body).toBe('通过后才可见的评论');
  });

  it('未公开的回复不计入 replyCount，也不出现在回复列表', async () => {
    const { ctx, reviewId } = await setupPublishedReview();

    // 顶层评论（直接置为已公开）
    const rootId = insertRootComment(db, { contentEntityId: reviewId, authorId: ctx.userId as string });
    const now = Date.now();
    const rootRev = newId();
    db.prepare(
      `INSERT INTO comment_revisions (id, comment_id, revision_number, body, submitted_at) VALUES (?, ?, 1, '顶层', ?)`,
    ).run(rootRev, rootId, now);
    db.prepare('UPDATE comments SET published_revision_id = ?, first_published_at = ? WHERE id = ?').run(rootRev, now, rootId);

    // 用服务创建一条回复（此刻尚未公开）
    const reply = await commentsService.createComment(
      ctx,
      { contentEntityId: reviewId, body: '还没公开的回复', replyToCommentId: rootId, requestKey: `rk-${newId()}` },
      db,
    );

    // 回复列表必须看不到它
    const replies = await commentsService.listReplies(rootId, { page: 1, page_size: 20 }, db);
    expect(replies.total).toBe(0);
    expect(replies.items).toEqual([]);

    // 顶层条目上的 replyCount 也不能把它算进去（否则等于泄露"存在一条回复"）
    const roots = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    const rootItem = roots.items.find((c) => c.commentId === rootId);
    expect(rootItem?.replyCount).toBe(0);

    // 公开该回复后，两处都应更新
    const replyRev = db
      .prepare('SELECT id FROM comment_revisions WHERE comment_id = ?')
      .get(reply.commentId) as { id: string };
    db.prepare('UPDATE comments SET published_revision_id = ?, first_published_at = ? WHERE id = ?').run(
      replyRev.id,
      now,
      reply.commentId,
    );

    const replies2 = await commentsService.listReplies(rootId, { page: 1, page_size: 20 }, db);
    expect(replies2.total).toBe(1);
    expect(replies2.items[0]?.body).toBe('还没公开的回复');

    const roots2 = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);
    expect(roots2.items.find((c) => c.commentId === rootId)?.replyCount).toBe(1);
  });
});
