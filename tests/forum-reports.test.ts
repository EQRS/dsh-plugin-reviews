/**
 * 讨论区 · 举报接入（迁移 0038）。
 *
 * 重点测：
 *   1. 能举报帖子与回复，且这两类不写 content_entity_id；
 *   2. 已删除 / 待审的目标不能被举报（举报者本来就看不到它们）；
 *   3. 管理员 hide 会把目标软删（与作者删走同一条路）；
 *   4. 同一人对同一目标同一原因只留一条未处理举报。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createInteractionsService } from '../src/server/modules/interactions';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

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

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const alice = insertUser(db);
  const bob = insertUser(db);
  ensureDefaultBoards(db);
  return {
    db,
    admin,
    alice,
    bob,
    posts: createForumPostService({ db }),
    interactions: createInteractionsService({ db }),
  };
}

describe('举报帖子', () => {
  it('可以举报，落库时 content_entity_id 为空、post_id 有值', async () => {
    const { db, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '正常帖子',
      bodyMd: '正常内容',
    });

    const r = await interactions.createReport(caller(db, bob), {
      targetKind: 'post',
      targetId: postId,
      reason: 'spam',
    });
    expect(r.created).toBe(true);

    const row = db.prepare('SELECT content_entity_id, post_id, forum_reply_id FROM reports WHERE id = ?').get(r.reportId) as {
      content_entity_id: string | null;
      post_id: string | null;
      forum_reply_id: string | null;
    };
    expect(row.content_entity_id).toBeNull();
    expect(row.post_id).toBe(postId);
    expect(row.forum_reply_id).toBeNull();
  });

  it('同一人同一目标同一原因只留一条未处理', async () => {
    const { db, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '帖子',
      bodyMd: '内容',
    });
    const first = await interactions.createReport(caller(db, bob), {
      targetKind: 'post',
      targetId: postId,
      reason: 'spam',
    });
    const second = await interactions.createReport(caller(db, bob), {
      targetKind: 'post',
      targetId: postId,
      reason: 'spam',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reportId).toBe(first.reportId);
  });

  it('已删除的帖子不能被举报', async () => {
    const { db, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '帖子',
      bodyMd: '内容',
    });
    await posts.deletePost(caller(db, alice), postId);

    await expect(
      interactions.createReport(caller(db, bob), { targetKind: 'post', targetId: postId, reason: 'spam' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.TARGET_UNAVAILABLE);
  });

  it('待审的帖子不能被举报（举报者本来也看不到）', async () => {
    const { db, alice, bob, posts, interactions } = setup();
    const { postId, pendingReview } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '出闲置',
      bodyMd: '有意加微信详聊',
    });
    expect(pendingReview).toBe(true);

    await expect(
      interactions.createReport(caller(db, bob), { targetKind: 'post', targetId: postId, reason: 'spam' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.TARGET_UNAVAILABLE);
  });
});

describe('举报回复', () => {
  it('可以举报回复，落库时填 forum_reply_id', async () => {
    const { db, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '帖子',
      bodyMd: '内容',
    });
    const { replyId } = await posts.createReply(caller(db, alice), postId, { bodyMd: '一条回复' });

    const r = await interactions.createReport(caller(db, bob), {
      targetKind: 'forum_reply',
      targetId: replyId,
      reason: 'abuse',
    });
    const row = db.prepare('SELECT forum_reply_id, post_id FROM reports WHERE id = ?').get(r.reportId) as {
      forum_reply_id: string | null;
      post_id: string | null;
    };
    expect(row.forum_reply_id).toBe(replyId);
    expect(row.post_id).toBeNull();
  });
});

describe('管理员处理', () => {
  it('hide 帖子 → 软删，且从列表消失', async () => {
    const { db, admin, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '违规帖子',
      bodyMd: '内容',
    });
    const r = await interactions.createReport(caller(db, bob), {
      targetKind: 'post',
      targetId: postId,
      reason: 'abuse',
    });

    await interactions.handleReport(caller(db, admin), r.reportId, { action: 'hide', reason: '确认违规' });

    const row = db.prepare('SELECT status, deleted_by FROM forum_posts WHERE id = ?').get(postId) as {
      status: string;
      deleted_by: string;
    };
    expect(row.status).toBe('deleted');
    expect(row.deleted_by).toBe(admin);

    const list = await posts.listPosts(caller(db, alice), 'general');
    expect(list.items).toHaveLength(0);
  });

  it('hide 回复 → 软删', async () => {
    const { db, admin, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '帖子',
      bodyMd: '内容',
    });
    const { replyId } = await posts.createReply(caller(db, alice), postId, { bodyMd: '违规回复' });
    const r = await interactions.createReport(caller(db, bob), {
      targetKind: 'forum_reply',
      targetId: replyId,
      reason: 'abuse',
    });

    await interactions.handleReport(caller(db, admin), r.reportId, { action: 'hide', reason: '确认违规' });

    const row = db.prepare('SELECT status FROM forum_post_replies WHERE id = ?').get(replyId) as { status: string };
    expect(row.status).toBe('deleted');
  });

  it('后台队列能描述讨论区目标并给出链接', async () => {
    const { db, admin, alice, bob, posts, interactions } = setup();
    const { postId } = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '被举报的帖子',
      bodyMd: '这里是正文',
    });
    await interactions.createReport(caller(db, bob), {
      targetKind: 'post',
      targetId: postId,
      reason: 'spam',
    });

    const queue = await interactions.listReports(caller(db, admin));
    expect(queue).toHaveLength(1);
    expect(queue[0].targetKind).toBe('post');
    expect(queue[0].targetExcerpt).toContain('被举报的帖子');
    expect(queue[0].targetHref).toBe('/forum/general/' + postId);
  });
});
