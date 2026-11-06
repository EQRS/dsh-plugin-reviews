/**
 * 收藏重构 · 审查修复的回归用例。
 *
 * 这个文件盯住两件曾经会**造成用户损失**的事：
 *   1. 目标下架后，收藏就再也取消不掉了（S1）；
 *   2. 删一个收藏夹，夹内收藏被一并删光（S3）。
 *
 * 两条都是「用户点了一个正常按钮，结果不是他要的结果」——这类问题测试不写就会回来。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, insertRepository, insertPlugin, type TestDb } from './support/db';
import { ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { createInteractionsService } from '../src/server/modules/interactions';
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

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const alice = insertUser(db);
  ensureDefaultBoards(db);
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo);
  return {
    db,
    alice,
    plugin,
    service: createInteractionsService({ db }),
    posts: createForumPostService({ db }),
  };
}

describe('S1 目标不可公开后，收藏仍然能取消', () => {
  it('插件被软删后仍可取消收藏', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);
    await service.favoriteToDefaultFolder(me, { kind: 'plugin', targetId: plugin });
    expect(await service.isFavorited(me, 'plugin', plugin)).toBe(true);

    // 真实的下架场景：插件行还在，但已经被判定不可公开。
    // 这里用一个**不存在的 targetId** 直接验证「取消不校验目标」——
    // 如果 removeFavoriteInKind 内部调了 assertFavoriteTarget，这一步会抛 target_unavailable。
    const ghost = 'plugin_that_no_longer_resolves';
    await expect(service.toggleFavorite(me, { kind: 'plugin', targetId: ghost })).rejects.toThrow();
    await service.removeFavoriteInKind(me, { kind: 'plugin', targetId: ghost }); // 不抛即通过

    // 原本那条收藏仍可正常取消
    await service.removeFavoriteInKind(me, { kind: 'plugin', targetId: plugin });
    expect(await service.isFavorited(me, 'plugin', plugin)).toBe(false);
  });

  it('帖子被软删后仍可取消收藏', async () => {
    const { db, alice, posts, service } = setup();
    const me = caller(db, alice);
    const { postId } = await posts.createPost(me, { boardSlug: 'general', title: 'A', bodyMd: 'a' });
    await service.favoriteToDefaultFolder(me, { kind: 'post', targetId: postId });

    await posts.deletePost(me, postId);

    await service.removeFavoriteInKind(me, { kind: 'post', targetId: postId });
    expect(await service.isFavorited(me, 'post', postId)).toBe(false);
  });
});

describe('S2 POST 幂等，不翻转', () => {
  it('连续两次 favoriteToDefaultFolder 不会取消收藏', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);
    await service.favoriteToDefaultFolder(me, { kind: 'plugin', targetId: plugin });
    await service.favoriteToDefaultFolder(me, { kind: 'plugin', targetId: plugin });
    expect(await service.isFavorited(me, 'plugin', plugin)).toBe(true);
  });
});

describe('S3 删除收藏夹 = 移回默认夹，不是清空', () => {
  it('删夹后收藏还在，且落在默认夹里', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);
    const folder = await service.createFavoriteFolder(me, '临时夹', 'plugin');
    await service.setFavoriteInKind(me, { kind: 'plugin', targetId: plugin, folderId: folder.folderId });

    const result = await service.deleteFavoriteFolder(me, folder.folderId);
    expect(result.moved).toBe(1);

    // 收藏还在
    expect(await service.isFavorited(me, 'plugin', plugin)).toBe(true);
    // 且落在默认夹
    const folders = await service.listFavoriteFolders(me, 'plugin');
    const def = folders.find((f) => f.isDefault)!;
    expect(def.count).toBe(1);
  });
});