/**
 * catalog 模块测试（工作包 GI）。
 *
 * 纪律：每个用例都必须**能在实现被破坏时变红**。两条最关键的对照：
 *  - 「同一仓库同一子路径重复提交只产生一个 plugin」：若去掉幂等查询、改成无条件 INSERT，
 *    会撞 UNIQUE(repository_id, plugin_path) 抛错，或产生两行，本条失败；
 *  - 「缺 dsh.bundle 的仓库被拒」：若把收录检查短路成"直接收录"，本条失败。
 *
 * 探针（CatalogProbe）用内存桩注入：收录判定不依赖网络，才能穷尽组合。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createCatalogService } from '../src/server/modules/catalog/service';
import { ROOT_PLUGIN_PATH, parseSubmissionUrl } from '../src/server/modules/catalog/parse-url';
import { ErrorCodes, err as errorHelpers } from '../src/packages/common/errors';
import type { CallerContextLike, CatalogProbe, CatalogService } from '../src/server/modules/catalog/types';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

const T0 = 1_760_000_000_000;

function setup(): { testDb: TestDb; service: CatalogService; userId: string } {
  const testDb = createTestDb();
  ctx = testDb;
  const service = createCatalogService({ db: testDb.db });
  const userId = insertUser(testDb.db);
  return { testDb, service, userId };
}

function activeCaller(userId: string): CallerContextLike {
  return { userId, role: 'user', accountStatus: 'active' };
}

/** 可控探针：记录调用参数，便于断言"检查真的做了"。 */
function makeProbe(options: {
  repoId?: string;
  archived?: boolean;
  manifest?: { bundlePath: string; bundleExists: boolean } | null;
  onRepo?: () => void;
  onManifest?: () => void;
}): CatalogProbe & { calls: { repo: number; manifest: number; manifestPaths: string[] } } {
  const calls = { repo: 0, manifest: 0, manifestPaths: [] as string[] };
  return {
    calls,
    async fetchRepository() {
      calls.repo += 1;
      options.onRepo?.();
      return {
        githubRepositoryId: options.repoId ?? '9001',
        fullName: 'owner/repo',
        htmlUrl: 'https://github.com/owner/repo',
        isArchived: options.archived ?? false,
      };
    },
    async fetchPluginManifest(input: { owner: string; repo: string; pluginPath: string }) {
      calls.manifest += 1;
      calls.manifestPaths.push(input.pluginPath);
      options.onManifest?.();
      return options.manifest === undefined ? { bundlePath: 'dsh.bundle.json', bundleExists: true } : options.manifest;
    },
  };
}

function countPlugins(db: TestDb['db']): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number }).c;
}

function countRepositories(db: TestDb['db']): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM repositories').get() as { c: number }).c;
}

describe('parseSubmissionUrl：链接解析与归一化', () => {
  it('仓库首页 → pluginPath 归一为 "."', () => {
    expect(parseSubmissionUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: ROOT_PLUGIN_PATH,
    });
    // 结尾斜杠与 .git 后缀都要能接受（复制粘贴自地址栏的常见形态）。
    expect(parseSubmissionUrl('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: '.',
    });
    expect(parseSubmissionUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: '.',
    });
  });

  it('tree/<branch> → 根目录归一为 "."', () => {
    expect(parseSubmissionUrl('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: '.',
    });
    expect(parseSubmissionUrl('https://github.com/owner/repo/tree/main/')).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: '.',
    });
  });

  it('tree/<branch>/<subpath> → 保留子路径实际大小写', () => {
    expect(parseSubmissionUrl('https://github.com/owner/repo/tree/main/src/plugins/Foo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: 'src/plugins/Foo',
    });
  });

  it('40 位 commit SHA 作为 ref：其余全部是子路径', () => {
    const sha = 'a'.repeat(40);
    expect(parseSubmissionUrl(`https://github.com/owner/repo/tree/${sha}/packages/alpha`)).toEqual({
      owner: 'owner',
      repo: 'repo',
      pluginPath: 'packages/alpha',
    });
  });

  it('无法解析的输入明确返回 { error }，不返回半个结果', () => {
    const bad = [
      '',
      '   ',
      'not a url',
      'ftp://github.com/owner/repo',
      'https://gitlab.com/owner/repo',
      'https://github.com/owner',
      'https://github.com/owner/repo/blob/main/package.json',
      'https://github.com/owner/repo/issues/12',
    ];
    for (const url of bad) {
      const result = parseSubmissionUrl(url);
      expect(result, `输入 ${JSON.stringify(url)} 应返回 error`).toHaveProperty('error');
      expect('owner' in result).toBe(false);
    }
  });

  it('仓库名非法字符被拒绝（不把奇怪输入带进数据库）', () => {
    expect(parseSubmissionUrl('https://github.com/owner/re po')).toHaveProperty('error');
    expect(parseSubmissionUrl('https://github.com//repo')).toHaveProperty('error');
  });
});

describe('acceptPluginSubmission：收录检查', () => {
  it('仓库可访问 + 有 dsh.bundle + 配置文件存在 → 收录成功', async () => {
    const { testDb, service, userId } = setup();
    const probe = makeProbe({});
    const result = await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo/tree/main/plugins/alpha', requestKey: 'rk-1' },
      { probe },
    );

    expect(result.status).toBe('accepted');
    expect(result.created).toBe(true);
    expect(countPlugins(testDb.db)).toBe(1);

    const plugin = testDb.db
      .prepare('SELECT repository_id, plugin_path FROM plugins WHERE id = ?')
      .get(result.pluginId) as { repository_id: string; plugin_path: string };
    expect(plugin.plugin_path).toBe('plugins/alpha');
    expect(plugin.repository_id).toBe(result.repositoryId);

    const repo = testDb.db.prepare('SELECT * FROM repositories WHERE id = ?').get(result.repositoryId) as {
      github_repository_id: string;
      availability_state: string;
      is_archived: number;
    };
    expect(repo.github_repository_id).toBe('9001');
    expect(repo.availability_state).toBe('available');
    expect(repo.is_archived).toBe(0);

    // 探针真的被调用：仓库 1 次、清单 1 次且路径正确。
    expect(probe.calls.repo).toBe(1);
    expect(probe.calls.manifest).toBe(1);
    expect(probe.calls.manifestPaths).toEqual(['plugins/alpha']);
  });

  it('【对照】缺 dsh.bundle 的仓库 → 收录被拒（不写任何行）', async () => {
    const { testDb, service, userId } = setup();
    // 探针返回 null 表示 package.json 不存在或未声明 dsh.bundle。
    const probe = makeProbe({ manifest: null });

    await expect(
      service.acceptPluginSubmission(
        activeCaller(userId),
        { url: 'https://github.com/owner/repo', requestKey: 'rk-1' },
        { probe },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });

    // 若把收录检查短路（先收录再校验），下面三条必然失败。
    expect(countPlugins(testDb.db)).toBe(0);
    expect(countRepositories(testDb.db)).toBe(0);
    expect(probe.calls.manifest).toBe(1);
  });

  it('【对照】dsh.bundle 声明了但引用的配置文件不存在 → 收录被拒', async () => {
    const { testDb, service, userId } = setup();
    const probe = makeProbe({ manifest: { bundlePath: 'dsh.bundle.json', bundleExists: false } });

    await expect(
      service.acceptPluginSubmission(
        activeCaller(userId),
        { url: 'https://github.com/owner/repo', requestKey: 'rk-1' },
        { probe },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });

    expect(countPlugins(testDb.db)).toBe(0);
    expect(countRepositories(testDb.db)).toBe(0);
  });

  it('dsh.bundle 声明为空白 → 收录被拒', async () => {
    const { testDb, service, userId } = setup();
    const probe = makeProbe({ manifest: { bundlePath: '   ', bundleExists: true } });
    await expect(
      service.acceptPluginSubmission(
        activeCaller(userId),
        { url: 'https://github.com/owner/repo', requestKey: 'rk-1' },
        { probe },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });
    expect(countPlugins(testDb.db)).toBe(0);
  });

  it('已归档仓库 → 收录被拒', async () => {
    const { testDb, service, userId } = setup();
    const probe = makeProbe({ archived: true });
    await expect(
      service.acceptPluginSubmission(
        activeCaller(userId),
        { url: 'https://github.com/owner/repo', requestKey: 'rk-1' },
        { probe },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.TARGET_UNAVAILABLE });
    expect(countPlugins(testDb.db)).toBe(0);
    expect(countRepositories(testDb.db)).toBe(0);
  });

  it('仓库探针故障 → 传播 provider_unavailable，不落半条数据', async () => {
    const { testDb, service, userId } = setup();
    const probe: CatalogProbe = {
      async fetchRepository() {
        throw errorHelpers.providerDown('GitHub 不可用。');
      },
      async fetchPluginManifest() {
        return { bundlePath: 'x', bundleExists: true };
      },
    };

    await expect(
      service.acceptPluginSubmission(
        activeCaller(userId),
        { url: 'https://github.com/owner/repo', requestKey: 'rk-1' },
        { probe },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_UNAVAILABLE });

    // 事务外调用探针 + 失败即整体不写：仓库与插件都不该留下。
    expect(countRepositories(testDb.db)).toBe(0);
    expect(countPlugins(testDb.db)).toBe(0);
  });

  it('未登录 / 账户禁用 / 缺请求键 / 无探针 一律拒绝', async () => {
    const { service, userId } = setup();
    const probe = makeProbe({});
    const url = 'https://github.com/owner/repo';
    const input = { url, requestKey: 'rk-1' };

    await expect(
      service.acceptPluginSubmission({ userId: null, role: null, accountStatus: null }, input, { probe }),
    ).rejects.toMatchObject({ code: ErrorCodes.UNAUTHENTICATED });

    await expect(
      service.acceptPluginSubmission({ userId, role: 'user', accountStatus: 'disabled' }, input, { probe }),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCOUNT_DISABLED });

    await expect(
      service.acceptPluginSubmission(activeCaller(userId), { url, requestKey: '   ' }, { probe }),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });

    await expect(
      service.acceptPluginSubmission(activeCaller(userId), input, {} as { probe: CatalogProbe }),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_NOT_CONFIGURED });
  });

  it('链接无法解析 → input_invalid，且不调用探针', async () => {
    const { testDb, service, userId } = setup();
    const probe = makeProbe({});
    await expect(
      service.acceptPluginSubmission(activeCaller(userId), { url: 'https://gitlab.com/a/b', requestKey: 'rk-1' }, { probe }),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });
    expect(probe.calls.repo).toBe(0);
    expect(probe.calls.manifest).toBe(0);
    expect(countRepositories(testDb.db)).toBe(0);
  });
});

describe('acceptPluginSubmission：幂等与请求去重', () => {
  it('【对照】同一仓库同一子路径重复提交 → 只产生一个 plugin', async () => {
    const { testDb, service, userId } = setup();
    const url = 'https://github.com/owner/repo/tree/main/plugins/alpha';

    const first = await service.acceptPluginSubmission(activeCaller(userId), { url, requestKey: 'rk-1' }, { probe: makeProbe({}) });
    const second = await service.acceptPluginSubmission(activeCaller(userId), { url, requestKey: 'rk-2' }, { probe: makeProbe({}) });
    const third = await service.acceptPluginSubmission(activeCaller(userId), { url, requestKey: 'rk-3' }, { probe: makeProbe({}) });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    // 复用既有插件：ID 必须一致。
    expect(second.pluginId).toBe(first.pluginId);
    expect(third.pluginId).toBe(first.pluginId);
    // 若去掉幂等查询改成无条件 INSERT，这里是 3（或直接抛 UNIQUE 错误）。
    expect(countPlugins(testDb.db)).toBe(1);
    // 仓库也只建一条。
    expect(countRepositories(testDb.db)).toBe(1);
    expect(second.repositoryId).toBe(first.repositoryId);
  });

  it('不同子路径 → 各自独立的 plugin 行（幂等不能退化成"一仓库一插件"）', async () => {
    const { testDb, service, userId } = setup();
    const a = await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo/tree/main/plugins/alpha', requestKey: 'rk-a' },
      { probe: makeProbe({}) },
    );
    const b = await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo/tree/main/plugins/beta', requestKey: 'rk-b' },
      { probe: makeProbe({}) },
    );

    expect(a.pluginId).not.toBe(b.pluginId);
    expect(countPlugins(testDb.db)).toBe(2);
    // 同一仓库：复用 repositories 行。
    expect(b.repositoryId).toBe(a.repositoryId);
    expect(countRepositories(testDb.db)).toBe(1);
  });

  it('根目录写法（无 tree / tree/main / 尾斜杠）归一后是同一个插件', async () => {
    const { testDb, service, userId } = setup();
    const variants = [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo/',
      'https://github.com/owner/repo/tree/main',
      'https://github.com/owner/repo.git',
    ];
    const ids: string[] = [];
    for (const [i, url] of variants.entries()) {
      const r = await service.acceptPluginSubmission(
        activeCaller(userId),
        { url, requestKey: `rk-${i}` },
        { probe: makeProbe({}) },
      );
      ids.push(r.pluginId);
    }
    // 四种写法都归一为 '.'，因此只能是同一行。
    expect(new Set(ids).size).toBe(1);
    expect(countPlugins(testDb.db)).toBe(1);
    const row = testDb.db.prepare('SELECT plugin_path FROM plugins').get() as { plugin_path: string };
    expect(row.plugin_path).toBe('.');
  });

  it('【对照】同 request_key 同摘要 → 返回原结果，不重复建插件', async () => {
    const { testDb, service, userId } = setup();
    const url = 'https://github.com/owner/repo/tree/main/plugins/alpha';
    const input = { url, requestKey: 'same-key' };

    const first = await service.acceptPluginSubmission(activeCaller(userId), input, { probe: makeProbe({}) });
    // 重放：探针可以返回不同内容（真实世界会变），但同键同摘要必须返回原结果。
    const replay = await service.acceptPluginSubmission(activeCaller(userId), input, {
      probe: makeProbe({ manifest: null }),
    });

    expect(replay.pluginId).toBe(first.pluginId);
    expect(replay.repositoryId).toBe(first.repositoryId);
    expect(replay.created).toBe(false);
    expect(countPlugins(testDb.db)).toBe(1);
  });

  it('【对照】同 request_key 不同摘要 → request_key_reused', async () => {
    const { testDb, service, userId } = setup();
    await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo/tree/main/plugins/alpha', requestKey: 'k' },
      { probe: makeProbe({}) },
    );

    await expect(
      service.acceptPluginSubmission(
        activeCaller(userId),
        { url: 'https://github.com/owner/repo/tree/main/plugins/beta', requestKey: 'k' },
        { probe: makeProbe({}) },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_KEY_REUSED });

    // 冲突请求不得写入第二个插件。
    expect(countPlugins(testDb.db)).toBe(1);
  });

  it('不同仓库（不同 GitHub repository_id）→ 各自建仓库行', async () => {
    const { testDb, service, userId } = setup();
    await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo', requestKey: 'rk-1' },
      { probe: makeProbe({ repoId: '111' }) },
    );
    await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/other', requestKey: 'rk-2' },
      { probe: makeProbe({ repoId: '222' }) },
    );
    expect(countRepositories(testDb.db)).toBe(2);
    expect(countPlugins(testDb.db)).toBe(2);
  });

  it('已有仓库再次收录时资料被同步（full_name/归档状态更新，不新建仓库）', async () => {
    const { testDb, service, userId } = setup();
    const url = 'https://github.com/owner/repo/tree/main/plugins/alpha';
    const first = await service.acceptPluginSubmission(activeCaller(userId), { url, requestKey: 'rk-1' }, { probe: makeProbe({}) });

    await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo/tree/main/plugins/beta', requestKey: 'rk-2' },
      { probe: makeProbe({ archived: false }) },
    );

    expect(countRepositories(testDb.db)).toBe(1);
    const repo = testDb.db.prepare('SELECT availability_state, last_successful_check_at FROM repositories WHERE id = ?').get(first.repositoryId) as {
      availability_state: string;
      last_successful_check_at: number | null;
    };
    expect(repo.availability_state).toBe('available');
    expect(repo.last_successful_check_at).not.toBeNull();
  });
});

describe('getPlugin 与 listPlugins', () => {
  it('getPlugin 返回插件与其仓库来源状态；不存在返回 null', async () => {
    const { service, userId } = setup();
    const created = await service.acceptPluginSubmission(
      activeCaller(userId),
      { url: 'https://github.com/owner/repo/tree/main/plugins/alpha', requestKey: 'rk-1' },
      { probe: makeProbe({}) },
    );

    const view = await service.getPlugin(created.pluginId);
    expect(view).not.toBeNull();
    expect(view!.pluginId).toBe(created.pluginId);
    expect(view!.pluginPath).toBe('plugins/alpha');
    expect(view!.repository.repositoryId).toBe(created.repositoryId);
    expect(view!.repository.fullName).toBe('owner/repo');
    expect(view!.repository.htmlUrl).toBe('https://github.com/owner/repo');
    expect(view!.repository.isArchived).toBe(false);
    expect(view!.repository.availabilityState).toBe('available');

    expect(await service.getPlugin('00000000-0000-7000-8000-000000000000')).toBeNull();
    expect(await service.getPlugin('')).toBeNull();
  });

  it('listPlugins 分页：总数正确、页大小生效、固定排序不重复', async () => {
    const { testDb, service, userId } = setup();
    // 建 3 个插件，updated_at 递增以便断言排序。
    for (let i = 0; i < 3; i += 1) {
      await service.acceptPluginSubmission(
        activeCaller(userId),
        { url: `https://github.com/owner/repo/tree/main/plugins/p${i}`, requestKey: `rk-${i}` },
        { probe: makeProbe({}) },
      );
    }
    // 让 updated_at 有明显差异（同毫秒会让排序断言不稳定）。
    const ids = (testDb.db.prepare('SELECT id FROM plugins ORDER BY plugin_path').all() as { id: string }[]).map((r) => r.id);
    ids.forEach((id, i) => {
      testDb.db.prepare('UPDATE plugins SET updated_at = ? WHERE id = ?').run(T0 + i * 1000, id);
    });

    const page1 = await service.listPlugins({ page: 1, page_size: 2 });
    expect(page1.total).toBe(3);
    expect(page1.total_pages).toBe(2);
    expect(page1.items).toHaveLength(2);
    expect(page1.has_next).toBe(true);
    expect(page1.has_previous).toBe(false);
    // updated_at DESC：最后写入的 p2 排最前。
    expect(page1.items[0]!.pluginPath).toBe('plugins/p2');
    expect(page1.items[0]!.repositoryFullName).toBe('owner/repo');

    const page2 = await service.listPlugins({ page: 2, page_size: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.has_next).toBe(false);
    expect(page2.has_previous).toBe(true);

    // 两页合计不重复、不遗漏。
    const all = [...page1.items, ...page2.items].map((p) => p.pluginId);
    expect(new Set(all).size).toBe(3);
  });

  it('listPlugins 空库返回空页（不报错、不返回 undefined）', async () => {
    const { service } = setup();
    const page = await service.listPlugins({ page: 1, page_size: 20 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.total_pages).toBe(0);
    expect(page.has_next).toBe(false);
  });
});
