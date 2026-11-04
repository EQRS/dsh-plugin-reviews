/**
 * 收藏接口带上 kind（交接文档 §6.1）。
 *
 * 这里钉的是**兼容口径**，不是文案：
 *  1. 不带 kind 的老调用必须仍然按插件走 —— 这是 0039 之前接口唯一有的语义，
 *     老收藏按钮与老收藏页都不带这个参数，改坏了它们会静默失效；
 *  2. 带 kind=pack / post 时走对应的收藏表，且收藏夹列表按类型隔离；
 *  3. 非法 kind 一律 400（不是静默回落到插件，那会把写错当成成功）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话 Cookie 的可变桩：读取时按当前值返回。 */
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (auth.token === null ? undefined : { name, value: auth.token }),
  }),
}));

import { GET as getFavorites, POST as postFavorites, DELETE as deleteFavorites } from '../src/app/api/me/favorites/route';
import { GET as getFolders, POST as postFolders } from '../src/app/api/me/favorites/folders/route';
import { closeDb, type SqliteDatabase } from '../src/server/platform/db';
import { createIdentityService } from '../src/server/modules/identity';
import { createPacksService } from '../src/server/modules/packs';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import type { VersionValue } from '@/packages/common/field-rules';

let h: TestDb;
let db: SqliteDatabase;

beforeEach(() => {
  h = createTestDb();
  db = h.db;
  process.env.DSH_REVIEW_DB_PATH = h.file;
  closeDb();
  auth.token = null;
});

afterEach(() => {
  closeDb();
  h.cleanup();
  delete process.env.DSH_REVIEW_DB_PATH;
  auth.token = null;
});

async function signIn(userId: string): Promise<void> {
  const identity = createIdentityService({ db });
  const session = await identity.createSession(userId, Date.now());
  auth.token = session.token;
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface OkBody<T> {
  ok: true;
  data: T;
}
interface ErrorBody {
  ok: false;
  error: { code: string; message: string };
}

const V_KNOWN = (value: string): VersionValue => ({ kind: 'known', value });

/** 造一个已发布公开版本的整合包（能被收藏的最小条件）。 */
async function seedPublishedPack(authorId: string): Promise<string> {
  const repoId = insertRepository(db, `gh-pack-${Math.random().toString(16).slice(2)}`);
  const pluginId = insertPlugin(db, repoId, 'pack-target');
  const packs = createPacksService({ db });
  const created = await packs.createPackWithFirstRelease(
    { userId: authorId, role: 'user', accountStatus: 'active' },
    {
      title: '演示整合包',
      purpose: '给收藏接口测试用',
      bodyMarkdown: '正文',
      dshVersion: { kind: 'unknown' },
      configTemplate: null,
      testStatus: 'untested',
      testTask: null,
      testResult: null,
      items: [
        {
          pluginId,
          pluginVersion: V_KNOWN('1.0.0'),
          installTarget: { kind: 'npm', packageName: 'demo-pack', version: '1.0.0' },
        },
      ],
    },
  );
  return created.packId;
}

describe('收藏接口：kind 兼容口径', () => {
  it('不带 kind 的老调用仍按插件走（POST 与 DELETE 都是）', async () => {
    const user = insertUser(db, { nickname: '老用户' });
    const repoId = insertRepository(db, `gh-plugin-${Math.random().toString(16).slice(2)}`);
    const pluginId = insertPlugin(db, repoId, 'legacy-plugin');
    await signIn(user);

    // 老写法：body 里只有 pluginId，没有 kind
    const created = await postFavorites(postJson('https://review.test/api/me/favorites', { pluginId }));
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as OkBody<{ favorited: boolean }>;
    expect(createdBody.data.favorited).toBe(true);

    // 收藏落在插件表里
    const rows = db.prepare('SELECT COUNT(*) AS c FROM plugin_favorites WHERE plugin_id = ?').get(pluginId) as { c: number };
    expect(rows.c).toBe(1);

    // 老写法：DELETE ?pluginId=
    const removed = await deleteFavorites(
      new Request(`https://review.test/api/me/favorites?pluginId=${pluginId}`, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(200);
    const after = db.prepare('SELECT COUNT(*) AS c FROM plugin_favorites WHERE plugin_id = ?').get(pluginId) as { c: number };
    expect(after.c).toBe(0);
  });

  it('kind=pack：收藏进 pack_favorites，收藏夹列表按类型隔离', async () => {
    const author = insertUser(db, { nickname: '作者' });
    const reader = insertUser(db, { nickname: '读者' });
    const packId = await seedPublishedPack(author);
    await signIn(reader);

    const created = await postFavorites(
      postJson('https://review.test/api/me/favorites', { kind: 'pack', targetId: packId }),
    );
    expect(created.status).toBe(200);
    expect(((await created.json()) as OkBody<{ favorited: boolean }>).data.favorited).toBe(true);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM pack_favorites WHERE pack_id = ?').get(packId) as { c: number };
    expect(rows.c).toBe(1);

    // 收藏夹列表：pack 只有一个默认夹，plugin 也是各一个，互不遮挡
    const packFolders = await getFolders(new Request('https://review.test/api/me/favorites/folders?kind=pack'));
    const packList = ((await packFolders.json()) as OkBody<{ folders: Array<{ targetKind: string; count: number }> }>).data
      .folders;
    expect(packList).toHaveLength(1);
    expect(packList[0]!.targetKind).toBe('pack');
    expect(packList[0]!.count).toBe(1);

    const pluginFolders = await getFolders(new Request('https://review.test/api/me/favorites/folders'));
    const pluginList = ((await pluginFolders.json()) as OkBody<{ folders: Array<{ targetKind: string }> }>).data.folders;
    expect(pluginList.every((f) => f.targetKind === 'plugin')).toBe(true);

    // GET ?kind=pack 返回该类收藏
    const listed = await getFavorites(new Request('https://review.test/api/me/favorites?kind=pack'));
    const listedBody = (await listed.json()) as OkBody<{ kind: string; items: Array<{ targetId: string }> }>;
    expect(listedBody.data.kind).toBe('pack');
    expect(listedBody.data.items).toHaveLength(1);

    // DELETE ?targetId=&kind=pack 取消
    const removed = await deleteFavorites(
      new Request(`https://review.test/api/me/favorites?kind=pack&targetId=${packId}`, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as OkBody<{ favorited: boolean }>).data.favorited).toBe(false);
  });

  it('非法 kind → 400，不静默回落到插件', async () => {
    const user = insertUser(db, { nickname: '用户' });
    await signIn(user);

    const bad = await postFavorites(postJson('https://review.test/api/me/favorites', { kind: 'book', targetId: 'x' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).error.code).toBe('input_invalid');

    const badFolder = await postFolders(
      postJson('https://review.test/api/me/favorites/folders', { name: '我的夹', kind: 'book' }),
    );
    expect(badFolder.status).toBe(400);
  });

  it('同名夹只在同一类型内冲突：插件夹与帖子夹可以同名', async () => {
    const user = insertUser(db, { nickname: '用户' });
    await signIn(user);

    const pluginFolder = await postFolders(
      postJson('https://review.test/api/me/favorites/folders', { name: '常用' }),
    );
    expect(pluginFolder.status).toBe(201);

    const postFolder = await postFolders(
      postJson('https://review.test/api/me/favorites/folders', { name: '常用', kind: 'post' }),
    );
    expect(postFolder.status).toBe(201);

    // 同类型内再建同名 → 拒绝
    const dup = await postFolders(postJson('https://review.test/api/me/favorites/folders', { name: '常用' }));
    expect(dup.status).toBe(400);
  });
});
