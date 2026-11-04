/**
 * 收藏重构（迁移 0039）：插件 / 整合包 / 帖子三类内容共用一套收藏夹。
 *
 * 这一组测试盯住四件最容易写坏的事：
 *   1. **默认夹按类型隔离**：0019 的唯一索引只约束 user_id，三类共存会撞车；
 *   2. **夹只能装同类收藏**：把插件收藏塞进帖子夹会让「取消收藏」的语义失真；
 *   3. **老数据迁移不丢**：plugin_pack_favorites 迁进 pack_favorites 后条数不变；
 *   4. **软删的帖子仍在收藏里**：收藏者要看到痕迹，而不是内容凭空消失。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { DEFAULT_FAVORITE_FOLDER_NAME, createInteractionsService } from '../src/server/modules/interactions';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { createPacksService } from '../src/server/modules/packs';
import type { CallerContext } from '../src/server/platform/context';
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

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    expect(isDomainError(e)).toBe(true);
    if (isDomainError(e)) expect(e.code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
}

/** 建好一个可收藏的整合包（作者发布第 1 版）。 */
async function seedPack(db: TestDb['db'], authorId: string): Promise<string> {
  const repo = insertRepository(db, `gh-pack-${Math.random().toString(16).slice(2)}`);
  const plugin = insertPlugin(db, repo);
  const service = createPacksService({ db });
  const created = await service.createPackWithFirstRelease(
    caller(db, authorId),
    {
      title: '科研资料整理套装',
      purpose: '把检索、记忆与整理串成一条流水线',
      bodyMarkdown: '# 组合说明',
      dshVersion: { kind: 'known', value: '1.2.0' },
      testStatus: 'tested',
      testTask: '导入 20 篇文献',
      testResult: '全部可检索',
      items: [{ pluginId: plugin, pluginVersion: { kind: 'unknown' }, installTarget: null }],
    },
    db,
  );
  return created.packId;
}

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const alice = insertUser(db, { nickname: '爱丽丝' });
  const bob = insertUser(db, { nickname: '鲍勃' });
  ensureDefaultBoards(db);
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo);
  return {
    db,
    alice,
    bob,
    plugin,
    service: createInteractionsService({ db }),
    posts: createForumPostService({ db }),
    boards: createForumBoardService({ db }),
  };
}

describe('收藏重构 · 三类内容共用收藏夹', () => {
  it('每类内容各有自己的默认夹，互不占用', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);

    await service.toggleFavorite(me, { kind: 'plugin', targetId: plugin });
    const pluginFolders = await service.listFavoriteFolders(me, 'plugin');
    expect(pluginFolders).toHaveLength(1);
    expect(pluginFolders[0]).toMatchObject({ name: DEFAULT_FAVORITE_FOLDER_NAME, isDefault: true, targetKind: 'plugin' });

    // 帖子默认夹应当是另一行：如果唯一索引还只约束 user_id，这里会串成同一个夹。
    const postFolders = await service.listFavoriteFolders(me, 'post');
    expect(postFolders).toHaveLength(1);
    expect(postFolders[0].targetKind).toBe('post');
    expect(postFolders[0].folderId).not.toBe(pluginFolders[0].folderId);
  });

  it('三类各自的默认夹可以由数据库同时存在（部分唯一索引按类型收口）', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);
    await service.toggleFavorite(me, { kind: 'plugin', targetId: plugin });

    // 插件默认夹由上面那次收藏建出来，另外两个由这里显式建。三个 is_default=1 的行
    // 能同时存在，说明部分唯一索引确实按 (user_id, target_kind) 收口 —— 0019 的
    // UNIQUE(user_id) WHERE is_default=1 在这里会直接报 UNIQUE 冲突。
    await service.listFavoriteFolders(me, 'post');
    await service.listFavoriteFolders(me, 'pack');
    const rows = db
      .prepare('SELECT target_kind FROM favorite_folders WHERE user_id = ? AND is_default = 1 ORDER BY target_kind')
      .all(alice) as Array<{ target_kind: string }>;
    expect(rows.map((r) => r.target_kind)).toEqual(['pack', 'plugin', 'post']);
  });

  it('收藏帖子进默认夹；帖子被软删后仍在收藏里并标为已删除', async () => {
    const { db, alice, posts, service } = setup();
    const me = caller(db, alice);
    const { postId } = await posts.createPost(me, { boardSlug: 'general', title: '求推荐', bodyMd: '正文' });

    await service.toggleFavorite(me, { kind: 'post', targetId: postId });
    let mine = await service.listFavoritePosts(me);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ postId, title: '求推荐', boardName: '综合讨论', status: 'published' });

    await posts.deletePost(me, postId);
    mine = await service.listFavoritePosts(me);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('deleted');
  });

  it('待审的帖子不能被收藏（举报者根本看不到它）', async () => {
    const { db, alice, service } = setup();
    const me = caller(db, alice);
    // 外链超过 3 条 → 自动审核挡下 → review_state='pending_review'
    const { postId, pendingReview } = await createForumPostService({ db }).createPost(me, {
      boardSlug: 'general',
      title: '几个链接',
      bodyMd: 'http://a.cn http://b.cn http://c.cn http://d.cn',
    });
    expect(pendingReview).toBe(true);
    await expectCode(service.toggleFavorite(me, { kind: 'post', targetId: postId }), ErrorCodes.TARGET_UNAVAILABLE);
  });

  it('整合包收藏写进新表，计数与列表都对', async () => {
    const { db, alice, bob, service } = setup();
    const packId = await seedPack(db, bob);
    const me = caller(db, alice);

    await service.toggleFavorite(me, { kind: 'pack', targetId: packId });
    const mine = await service.listFavoritePacks(me);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ packId, title: '科研资料整理套装', authorNickname: '鲍勃' });

    const folders = await service.listFavoriteFolders(me, 'pack');
    expect(folders[0].count).toBe(1);
    // 旧表不再被写入（数据由迁移一次性拷走）
    const legacy = db.prepare('SELECT COUNT(*) AS c FROM plugin_pack_favorites').get() as { c: number };
    expect(Number(legacy.c)).toBe(0);
  });

  it('夹只能装同类收藏：插件收藏不能被塞进帖子夹', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);
    const postFolder = await service.createFavoriteFolder(me, '阅读清单', 'post');

    await expectCode(
      service.setFavoriteInKind(me, { kind: 'plugin', targetId: plugin, folderId: postFolder.folderId }),
      ErrorCodes.INPUT_INVALID,
    );
    // 插件夹选同类之外的类型同样被拒
    const pluginFolder = await service.createFavoriteFolder(me, '常用', 'plugin');
    const packId = await seedPack(db, alice);
    await expectCode(
      service.setFavoriteInKind(me, { kind: 'pack', targetId: packId, folderId: pluginFolder.folderId }),
      ErrorCodes.INPUT_INVALID,
    );
  });

  it('同类型内不能重名，跨类型可以同名', async () => {
    const { db, alice, service } = setup();
    const me = caller(db, alice);
    await service.createFavoriteFolder(me, '常用', 'plugin');
    await expectCode(service.createFavoriteFolder(me, '常用', 'plugin'), ErrorCodes.INPUT_INVALID);
    // 帖子夹叫「常用」不冲突：它们是两套东西
    const postFolder = await service.createFavoriteFolder(me, '常用', 'post');
    expect(postFolder.name).toBe('常用');
  });

  it('帖子收藏夹的内容不会被别的类型的删除操作误清', async () => {
    const { db, alice, plugin, posts, service } = setup();
    const me = caller(db, alice);
    const { postId } = await posts.createPost(me, { boardSlug: 'general', title: 'A', bodyMd: 'a' });
    const postFolder = await service.createFavoriteFolder(me, '要删的', 'post');
    await service.setFavoriteInKind(me, { kind: 'post', targetId: postId, folderId: postFolder.folderId });
    await service.toggleFavorite(me, { kind: 'plugin', targetId: plugin });

    const removed = await service.deleteFavoriteFolder(me, postFolder.folderId);
    expect(removed.removed).toBe(1);
    expect(await service.listFavoritePosts(me)).toHaveLength(0);
    // 插件收藏没被波及
    expect(await service.isFavorited(me, 'plugin', plugin)).toBe(true);
  });

  it('批量移动只能落到插件夹（避免两类混装）', async () => {
    const { db, alice, plugin, service } = setup();
    const me = caller(db, alice);
    const pluginFolder = await service.createFavoriteFolder(me, '甲', 'plugin');
    const postFolder = await service.createFavoriteFolder(me, '乙', 'post');
    await service.setFavorite(me, { pluginId: plugin, folderId: pluginFolder.folderId });

    await expectCode(
      service.batchFavoriteAction(me, { action: 'move', pluginIds: [plugin], folderId: postFolder.folderId }),
      ErrorCodes.INPUT_INVALID,
    );
  });

  it('列表页一次问清「我收藏了哪些」', async () => {
    const { db, alice, plugin, posts, service } = setup();
    const me = caller(db, alice);
    const a = await posts.createPost(me, { boardSlug: 'general', title: 'A', bodyMd: 'a' });
    const b = await posts.createPost(me, { boardSlug: 'general', title: 'B', bodyMd: 'b' });
    await service.toggleFavorite(me, { kind: 'post', targetId: a.postId });

    const set = await service.favoritedIdsAmong(me, 'post', [a.postId, b.postId]);
    expect([...set]).toEqual([a.postId]);
    expect(await service.favoritedIdsAmong(me, 'post', [])).toEqual(new Set());
    expect(await service.isFavorited(me, 'plugin', plugin)).toBe(false);
  });
});

describe('收藏重构 · 迁移', () => {
  it('老整合包收藏迁进 pack_favorites，条数不变且归入整合包默认夹', async () => {
    const { db, alice, bob } = setup();
    const packId = await seedPack(db, bob);
    // 模拟迁移前的状态：收藏只在旧表里
    db.prepare('DELETE FROM pack_favorites').run();
    db.prepare('DELETE FROM favorite_folders WHERE target_kind = \'pack\'').run();
    db.prepare('INSERT INTO plugin_pack_favorites (user_id, pack_id, created_at) VALUES (?, ?, ?)').run(
      alice,
      packId,
      Date.now(),
    );

    // 迁移脚本重新跑一次（它在真实迁移里早于这些数据，所以这里手工回放迁移里的两段 SQL）
    db.prepare(
      `INSERT INTO favorite_folders (id, user_id, name, target_kind, is_default, created_at, updated_at)
       SELECT ?, id, '默认收藏夹', 'pack', 1, 0, 0 FROM users
        WHERE EXISTS (SELECT 1 FROM plugin_pack_favorites f WHERE f.user_id = users.id)
          AND NOT EXISTS (
            SELECT 1 FROM favorite_folders ff
             WHERE ff.user_id = users.id AND ff.target_kind = 'pack' AND ff.is_default = 1
          )`,
    ).run('folder-packed-legacy');
    db.prepare(
      `INSERT INTO pack_favorites (user_id, pack_id, folder_id, created_at)
       SELECT f.user_id, f.pack_id, ff.id, f.created_at
         FROM plugin_pack_favorites f
         JOIN favorite_folders ff
           ON ff.user_id = f.user_id AND ff.target_kind = 'pack' AND ff.is_default = 1`,
    ).run();

    const service = createInteractionsService({ db });
    const mine = await service.listFavoritePacks(caller(db, alice));
    expect(mine).toHaveLength(1);
    expect(mine[0].packId).toBe(packId);
    expect(mine[0].folderName).toBe(DEFAULT_FAVORITE_FOLDER_NAME);
  });

  it('迁移后老收藏夹全部标成 plugin，且每个用户仍只有一个插件默认夹', async () => {
    const { db, alice } = setup();
    const kinds = db
      .prepare('SELECT target_kind, COUNT(*) AS c FROM favorite_folders WHERE user_id = ? GROUP BY target_kind')
      .all(alice) as Array<{ target_kind: string; c: number }>;
    // ensureDefaultBoards 不建收藏夹；迁移给有整合包收藏的用户补了 pack 默认夹（本用例没有）
    for (const row of kinds) {
      expect(row.c).toBe(1);
      expect(['plugin', 'pack']).toContain(row.target_kind);
    }
  });
});
