/**
 * 讨论区 · 帖子与回复（迁移 0037）。
 *
 * 重点测：
 *   1. 两层封顶（服务层给可读原因，触发器兜底）；
 *   2. 回复的回复不能带图；
 *   3. 软删后内容不可见但痕迹在，且不级联删别人的回复与点赞；
 *   4. 点赞只对顶层回复开放，且幂等切换；
 *   5. 分区权限穿透到发帖（whitelist / admin_only / 归档）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumPostService } from '../src/server/modules/forum/posts';
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
    boards: createForumBoardService({ db }),
  };
}

const basePost = { boardSlug: 'general', title: '大家用哪个整合包', bodyMd: '想听听大家的推荐。' };

describe('发帖', () => {
  it('登录用户可以在综合讨论区发帖，列表里能看到', async () => {
    const { db, alice, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    const page = await posts.listPosts(caller(db, alice), 'general');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].postId).toBe(postId);
    expect(page.items[0].title).toBe('大家用哪个整合包');
  });

  it('标题空 / 超长 被拒', async () => {
    const { db, alice, posts } = setup();
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, title: '   ' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, title: 'x'.repeat(121) }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('官方公告区：普通用户发不了，管理员可以', async () => {
    const { db, admin, alice, posts } = setup();
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, boardSlug: 'announcements' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
    await expect(
      posts.createPost(caller(db, admin), { ...basePost, boardSlug: 'announcements' }),
    ).resolves.toBeTruthy();
  });

  it('归档分区不能发帖', async () => {
    const { db, admin, alice, posts, boards } = setup();
    const board = db.prepare("SELECT id FROM forum_boards WHERE slug = 'general'").get() as { id: string };
    await boards.setBoardStatus(caller(db, admin), board.id, 'archived');
    await expect(
      posts.createPost(caller(db, alice), basePost),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
  });
});

describe('两层回复', () => {
  it('可以回复帖子，也可以回复那条回复；第三层被拒', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);

    const r1 = await posts.createReply(caller(db, bob), postId, { bodyMd: '我也想知道' });
    const r2 = await posts.createReply(caller(db, alice), postId, { bodyMd: '推荐 A', parentId: r1.replyId });
    expect(r2.replyId).toBeTruthy();

    // 第三层：服务层给出可读原因
    await expect(
      posts.createReply(caller(db, bob), postId, { bodyMd: '再回一层', parentId: r2.replyId }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('回复列表按两层组织：顶层带 children', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    const r1 = await posts.createReply(caller(db, bob), postId, { bodyMd: '顶层一' });
    await posts.createReply(caller(db, alice), postId, { bodyMd: '回一', parentId: r1.replyId });
    await posts.createReply(caller(db, bob), postId, { bodyMd: '顶层二' });

    const list = await posts.listReplies(caller(db, alice), postId);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children).toHaveLength(1);
    expect(list.items[0].children[0].bodyMd).toBe('回一');
    expect(list.items[1].children).toHaveLength(0);
  });

  it('跨帖回复被拒', async () => {
    const { db, alice, posts } = setup();
    const a = await posts.createPost(caller(db, alice), basePost);
    const b = await posts.createPost(caller(db, alice), { ...basePost, title: '另一帖' });
    const r1 = await posts.createReply(caller(db, alice), a.postId, { bodyMd: '顶' });
    await expect(
      posts.createReply(caller(db, alice), b.postId, { bodyMd: '越界', parentId: r1.replyId }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('回复数随回复增加', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    await posts.createReply(caller(db, bob), postId, { bodyMd: '一' });
    const r1 = await posts.createReply(caller(db, bob), postId, { bodyMd: '二' });
    await posts.createReply(caller(db, alice), postId, { bodyMd: '二的回复', parentId: r1.replyId });
    const detail = await posts.getPost(caller(db, alice), postId);
    expect(detail.replyCount).toBe(3);
  });
});

describe('图片', () => {
  function makeAttachment(db: TestDb['db'], owner: string, tag: string): string {
    const att = 'att_' + tag;
    const file = 'file_' + tag;
    const now = Date.now();
    db.prepare(
      "INSERT INTO attachments (id, uploaded_by, original_filename, processing_state, created_at, ready_at) VALUES (?,?,?,?,?,?)",
    ).run(att, owner, 'a.png', 'ready', now, now);
    db.prepare(
      "INSERT INTO attachment_files (id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height, content_hash, processing_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      file,
      att,
      'orig',
      'original',
      'image/png',
      100,
      10,
      10,
      // content_hash 的 CHECK 要求 64 位十六进制
      Array.from(tag)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
        .padEnd(64, '0')
        .slice(0, 64),
      'ready',
      now,
    );
    return file;
  }

  it('帖子与顶层回复可以带图，回复的回复不行', async () => {
    const { db, alice, posts } = setup();
    const file = makeAttachment(db, alice, 'x1');

    const { postId } = await posts.createPost(caller(db, alice), { ...basePost, fileIds: [file] });
    expect(postId).toBeTruthy();

    const r1 = await posts.createReply(caller(db, alice), postId, { bodyMd: '带图回复', fileIds: [file] });
    expect(r1.replyId).toBeTruthy();

    await expect(
      posts.createReply(caller(db, alice), postId, { bodyMd: '带图二层', parentId: r1.replyId, fileIds: [file] }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('不能挂别人上传的附件', async () => {
    const { db, alice, bob, posts } = setup();
    const bobFile = makeAttachment(db, bob, 'y1');
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, fileIds: [bobFile] }),
    ).rejects.toThrow(/只能引用本人上传的附件/);
  });
});

describe('软删', () => {
  it('作者删帖后列表里消失，但行还在、回复与点赞不受影响', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    await posts.createReply(caller(db, bob), postId, { bodyMd: '顶一下' });
    await posts.togglePostLike(caller(db, bob), postId);

    await posts.deletePost(caller(db, alice), postId);

    const page = await posts.listPosts(caller(db, alice), 'general');
    expect(page.items).toHaveLength(0);

    // 行还在
    const row = db.prepare('SELECT status, deleted_by, deleted_at FROM forum_posts WHERE id = ?').get(postId) as {
      status: string;
      deleted_by: string;
      deleted_at: number;
    };
    expect(row.status).toBe('deleted');
    expect(row.deleted_by).toBe(alice);
    expect(row.deleted_at).toBeGreaterThan(0);

    // 别人的痕迹没被抹掉
    const replies = db.prepare('SELECT COUNT(*) AS c FROM forum_post_replies WHERE post_id = ?').get(postId) as {
      c: number;
    };
    const likes = db.prepare('SELECT COUNT(*) AS c FROM forum_post_likes WHERE post_id = ?').get(postId) as {
      c: number;
    };
    expect(Number(replies.c)).toBe(1);
    expect(Number(likes.c)).toBe(1);
  });

  it('软删后不能回复、不能编辑、不能点赞', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    await posts.deletePost(caller(db, alice), postId);

    await expect(
      posts.createReply(caller(db, bob), postId, { bodyMd: '还能回复吗' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
    await expect(
      posts.editPost(caller(db, alice), postId, { title: '改标题', bodyMd: '改正文' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
    await expect(
      posts.togglePostLike(caller(db, bob), postId),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('别人不能删我的帖子', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    await expect(
      posts.deletePost(caller(db, bob), postId),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
  });

  it('本区区长可以删别人的帖子', async () => {
    const { db, alice, bob, posts, boards } = setup();
    const board = db.prepare("SELECT id FROM forum_boards WHERE slug = 'general'").get() as { id: string };
    const admin = insertUser(db, { role: 'admin' });
    await boards.transferOwner(caller(db, admin), board.id, bob);

    const { postId } = await posts.createPost(caller(db, alice), basePost);
    await posts.deletePost(caller(db, bob), postId);
    const row = db.prepare('SELECT status FROM forum_posts WHERE id = ?').get(postId) as { status: string };
    expect(row.status).toBe('deleted');
  });
});

describe('点赞', () => {
  it('帖子点赞可切换，计数跟着走', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);

    const first = await posts.togglePostLike(caller(db, bob), postId);
    expect(first).toEqual({ liked: true, count: 1 });
    const second = await posts.togglePostLike(caller(db, bob), postId);
    expect(second).toEqual({ liked: false, count: 0 });
  });

  it('顶层回复可点赞；回复的回复不行', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    const r1 = await posts.createReply(caller(db, bob), postId, { bodyMd: '顶层' });
    const r2 = await posts.createReply(caller(db, alice), postId, { bodyMd: '二层', parentId: r1.replyId });

    const liked = await posts.toggleReplyLike(caller(db, alice), r1.replyId);
    expect(liked).toEqual({ liked: true, count: 1 });

    await expect(
      posts.toggleReplyLike(caller(db, bob), r2.replyId),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });
});

describe('通知', () => {
  it('回复帖子通知作者；回复回复通知被回复的人', async () => {
    const { db, alice, bob, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);

    await posts.createReply(caller(db, bob), postId, { bodyMd: '回帖' });
    const r1 = db.prepare('SELECT id FROM forum_post_replies WHERE post_id = ?').get(postId) as { id: string };
    await posts.createReply(caller(db, alice), postId, { bodyMd: '回回复', parentId: r1.id });

    const notices = db
      .prepare('SELECT recipient_id, kind, detail FROM notifications ORDER BY created_at, id')
      .all() as Array<{ recipient_id: string; kind: string; detail: string }>;
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ recipient_id: alice, kind: 'forum_reply' });
    expect(notices[1]).toMatchObject({ recipient_id: bob, kind: 'forum_reply_to_reply' });
  });

  it('自己回复自己的帖子不发通知', async () => {
    const { db, alice, posts } = setup();
    const { postId } = await posts.createPost(caller(db, alice), basePost);
    await posts.createReply(caller(db, alice), postId, { bodyMd: '自己顶' });
    const count = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
    expect(Number(count.c)).toBe(0);
  });
});

describe('排序与置顶', () => {
  it('默认按发布时间倒序；可切到最后回复时间', async () => {
    const { db, alice, bob, posts } = setup();
    const first = await posts.createPost(caller(db, alice), { ...basePost, title: '早的' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await posts.createPost(caller(db, alice), { ...basePost, title: '晚的' });

    const byCreated = await posts.listPosts(caller(db, alice), 'general');
    expect(byCreated.items.map((i) => i.title)).toEqual(['晚的', '早的']);

    // 给"早的"回一条，它应该排到最前
    await new Promise((r) => setTimeout(r, 5));
    await posts.createReply(caller(db, bob), first.postId, { bodyMd: '顶' });

    const byLastReply = await posts.listPosts(caller(db, alice), 'general', { sort: 'last_reply' });
    expect(byLastReply.items.map((i) => i.title)).toEqual(['早的', '晚的']);
    void second;
  });

  it('置顶的排最前；普通用户不能置顶', async () => {
    const { db, alice, bob, posts } = setup();
    const a = await posts.createPost(caller(db, alice), { ...basePost, title: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    await posts.createPost(caller(db, alice), { ...basePost, title: 'B' });

    await expect(
      posts.setPinned(caller(db, bob), a.postId, true),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);

    const admin = insertUser(db, { role: 'admin' });
    await posts.setPinned(caller(db, admin), a.postId, true);
    const list = await posts.listPosts(caller(db, alice), 'general');
    expect(list.items[0].title).toBe('A');
  });
});

describe('我的帖子', () => {
  it('只返回自己的，不含已删除', async () => {
    const { db, alice, bob, posts } = setup();
    await posts.createPost(caller(db, alice), { ...basePost, title: '我的' });
    const gone = await posts.createPost(caller(db, alice), { ...basePost, title: '要删的' });
    await posts.createPost(caller(db, bob), { ...basePost, title: '别人的' });
    await posts.deletePost(caller(db, alice), gone.postId);

    const mine = await posts.listMine(caller(db, alice));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].title).toBe('我的');

    const deleted = await posts.listMine(caller(db, alice), { status: 'deleted' });
    expect(deleted.items).toHaveLength(1);
    expect(deleted.items[0].title).toBe('要删的');
  });
});
