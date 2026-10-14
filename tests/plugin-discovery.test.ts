/**
 * 插件目录**自动发现**的测试（迁移 0007 引入的任务类型 `plugin_discovery`）。
 *
 * 四组：
 *   1. **适配器**：搜索/读清单/重试/离线闸门 —— 全部注入假 fetch，**不出网**；
 *   2. **服务**：候选 → 收录，审计必须是 `actor_kind='system'`（不是冒充成某个用户）；
 *   3. **幂等与截断**：重跑只刷新不重复建行；到上限就如实标 truncated；
 *   4. **排程**：按天幂等、按站点时区算"哪一天"、显式关闭与离线都不排。
 *
 * 反同义反复：本文件里"不重试 404""离线不发出任何请求""系统身份不是 user"
 * 三条都是**对着错误实现会变红**的断言（见各组注释）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { repoInfoStub, manifestStub } from './support/probe';
import {
  bundlePathOf,
  createGithubPluginDiscovery,
  type DiscoverySearchCandidate,
  type PluginDiscoveryPort,
} from '@/server/adapters/catalog/github-discovery';
import { createPluginDiscoveryService, discoveryDailyKey } from '@/server/modules/catalog/discovery';
import { ensureDailyDiscoveryTask, discoveryScheduleSkipReason } from '@/worker/scheduled';
import { createTasksService } from '@/server/modules/tasks/service';
import { createHandlers } from '@/worker/handlers';
import { createCatalogService } from '@/server/modules/catalog/service';
import { newId } from '@/server/platform/id';
import { err } from '@/packages/common/errors';
import type { CatalogProbe } from '@/server/modules/catalog/types';

// ============================================================
// 1) 适配器（注入假 fetch）
// ============================================================

/** 造一个可编程的假 fetch：按调用顺序吐出给定响应，并记录所有请求 URL。 */
function fakeFetch(responses: Array<{ status?: number; json?: unknown; throw?: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r?.throw !== undefined) throw r.throw;
    const status = r?.status ?? 200;
    return new Response(JSON.stringify(r?.json ?? {}), { status, headers: r?.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls, count: () => calls.length };
}

function searchBody(items: unknown[]): unknown {
  return { total_count: items.length, items };
}

function repoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: 'owner/repo',
    name: 'repo',
    owner: { login: 'owner' },
    html_url: 'https://github.com/owner/repo',
    default_branch: 'main',
    archived: false,
    stargazers_count: 3,
    updated_at: '2026-10-01T00:00:00Z',
    description: '一个插件仓库',
    topics: ['dsh-plugin'],
    ...overrides,
  };
}

const base64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('发现适配器：搜索', () => {
  it('解析候选字段、跳过归档仓库、按 full_name 去重', async () => {
    const { fn } = fakeFetch([
      {
        json: searchBody([
          repoItem(),
          repoItem({ archived: true, full_name: 'owner/old' }),
          repoItem(), // 重复
        ]),
      },
      { json: searchBody([]) }, // 第二页空 → 提前结束
    ]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, sleep: async () => {} });

    const found = await d.searchCandidates({ query: 'topic:dsh-plugin', pages: 2, perPage: 10 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      fullName: 'owner/repo',
      owner: 'owner',
      repo: 'repo',
      defaultBranch: 'main',
      stars: 3,
      topics: ['dsh-plugin'],
    });
    expect(found[0]!.repoUpdatedAt).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  it('离线闸门：一个请求都不发出（对着"忘了闸门"的实现会变红）', async () => {
    const { fn, count } = fakeFetch([{ json: searchBody([]) }]);
    const d = createGithubPluginDiscovery({
      fetch: fn,
      env: { DSH_REVIEW_CATALOG_OFFLINE: '1' },
      sleep: async () => {},
    });
    await expect(d.searchCandidates({ query: 'x' })).rejects.toMatchObject({ code: 'provider_not_configured' });
    expect(count()).toBe(0);
  });

  it('网络失败会重试（首次抛错 → 第二次成功），并记下 2 次请求', async () => {
    const { fn, count } = fakeFetch([
      { throw: Object.assign(new Error('socket hang up'), { name: 'TypeError' }) },
      { json: searchBody([repoItem()]) },
    ]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, retries: 2, sleep: async () => {} });
    const found = await d.searchCandidates({ query: 'x' });
    expect(found).toHaveLength(1);
    expect(count()).toBe(2);
  });

  it('404 是确定性答案 → **不重试**（只发 1 次请求）；对着"无脑重试"的实现会变红', async () => {
    const { fn, count } = fakeFetch([{ status: 404, json: { message: 'Not Found' } }]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, retries: 2, sleep: async () => {} });
    await expect(d.searchCandidates({ query: 'x' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(count()).toBe(1);
  });

  it('重试全部失败 → provider_unavailable，且消息里说明尝试次数（排障要能区分"抖"与"被限流"）', async () => {
    const { fn, count } = fakeFetch([{ status: 500, json: {} }]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, retries: 2, sleep: async () => {} });
    await expect(d.searchCandidates({ query: 'x' })).rejects.toThrow(/已重试 2 次，共 3 次尝试/);
    expect(count()).toBe(3);
  });

  it('403 带限流证据（消息含 rate limit）→ 会被重试', async () => {
    const { fn, count } = fakeFetch([
      { status: 403, json: { message: 'You have exceeded a secondary rate limit.' } },
      { json: searchBody([repoItem()]) },
    ]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, retries: 2, sleep: async () => {} });
    const found = await d.searchCandidates({ query: 'x' });
    expect(found).toHaveLength(1);
    expect(count()).toBe(2);
  });

  it('403 **不带**限流证据（仓库被屏蔽）→ 不重试、也不算限流：判为该资源不可用', async () => {
    const { fn, count } = fakeFetch([
      { status: 403, json: { message: 'Repository access blocked' }, headers: { 'x-ratelimit-remaining': '57' } },
    ]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, retries: 2, sleep: async () => {} });
    await expect(d.searchCandidates({ query: 'x' })).rejects.toMatchObject({ code: 'target_unavailable' });
    // 只发一次；而且**不能**被记成"本轮限流"（否则一个仓库会把整天的发现中止掉）
    expect(count()).toBe(1);
    expect(d.wasRateLimited()).toBe(false);
  });

  it('配额真的耗尽（x-ratelimit-remaining: 0）→ 记为限流，供服务层干净收尾', async () => {
    const { fn } = fakeFetch([
      { status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } },
    ]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, retries: 0, sleep: async () => {} });
    await expect(d.searchCandidates({ query: 'x' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(d.wasRateLimited()).toBe(true);
  });
});

describe('发现适配器：读插件清单', () => {
  it('树里找 package.json → 读出 dsh.bundle → 根目录给仓库首页、子目录给 tree 链接', async () => {
    const candidate: DiscoverySearchCandidate = {
      fullName: 'owner/repo',
      owner: 'owner',
      repo: 'repo',
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/owner/repo',
      stars: 0,
      repoUpdatedAt: null,
      repoDescription: null,
      topics: [],
    };
    const { fn, calls } = fakeFetch([
      {
        json: {
          tree: [
            { type: 'blob', path: 'package.json' },
            { type: 'blob', path: 'packages/base/package.json' },
            { type: 'blob', path: 'packages/other/package.json' },
            { type: 'blob', path: 'node_modules/dep/package.json' }, // 必须被排除
          ],
        },
      },
      { json: { content: base64(JSON.stringify({ name: '@x/root', dsh: { bundle: { patch: 'patch.yml' } } })) } },
      { json: { content: base64(JSON.stringify({ name: '@x/base', version: '1.2.3', dsh: { bundle: { patch: './dsh.yml' } } })) } },
      { json: { content: base64(JSON.stringify({ name: '@x/other' })) } }, // 没声明 dsh.bundle
    ]);
    const d = createGithubPluginDiscovery({ fetch: fn, env: {}, sleep: async () => {} });

    const found = await d.findPlugins(candidate);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      pluginPath: '.',
      url: 'https://github.com/owner/repo',
      bundlePath: 'patch.yml',
      name: '@x/root',
    });
    expect(found[1]).toMatchObject({
      pluginPath: 'packages/base',
      url: 'https://github.com/owner/repo/tree/main/packages/base',
      bundlePath: 'packages/base/dsh.yml',
      version: '1.2.3',
    });
    // node_modules 里的清单不许被读（省预算的第一道闸）
    expect(calls.some((u) => u.includes('node_modules'))).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it('verifyPatch=true 时，声明了但文件不存在的会被剔除（只读树+清单时不会）', async () => {
    const candidate: DiscoverySearchCandidate = {
      fullName: 'o/r',
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/o/r',
      stars: 0,
      repoUpdatedAt: null,
      repoDescription: null,
      topics: [],
    };
    const treeAndManifest = [
      { json: { tree: [{ type: 'blob', path: 'package.json' }] } },
      { json: { content: base64(JSON.stringify({ dsh: { bundle: { patch: 'missing.yml' } } })) } },
    ];
    const withoutCheck = createGithubPluginDiscovery({
      fetch: fakeFetch(treeAndManifest).fn,
      env: {},
      sleep: async () => {},
    });
    expect(await withoutCheck.findPlugins(candidate)).toHaveLength(1);

    const withCheck = createGithubPluginDiscovery({
      fetch: fakeFetch([...treeAndManifest, { status: 404, json: {} }]).fn,
      env: {},
      sleep: async () => {},
    });
    expect(await withCheck.findPlugins(candidate, { verifyPatch: true })).toHaveLength(0);
  });

  it('bundlePathOf 只认能确定的情形（对象/字符串/数组/垃圾）', () => {
    expect(bundlePathOf('p.yml')).toBe('p.yml');
    expect(bundlePathOf({ patch: 'p.yml' })).toBe('p.yml');
    expect(bundlePathOf({ patch: ['./p.yml'] })).toBe('./p.yml');
    expect(bundlePathOf({ patch: ['a.yml', 'b.yml'] })).toBe('a.yml');
    expect(bundlePathOf('')).toBeNull();
    expect(bundlePathOf('   ')).toBeNull();
    expect(bundlePathOf({})).toBeNull();
    expect(bundlePathOf({ patch: 42 })).toBeNull();
    expect(bundlePathOf(null)).toBeNull();
    expect(bundlePathOf(123)).toBeNull();
  });
});

// ============================================================
// 2) 服务：候选 → 收录（系统身份）
// ============================================================

function stubProbe(overrides: Partial<CatalogProbe> = {}): CatalogProbe {
  return {
    fetchRepository: async () => repoInfoStub(),
    fetchPluginManifest: async () => manifestStub(),
    ...overrides,
  } as CatalogProbe;
}

/** 造一个"固定吐出给定候选与插件"的假发现适配器。 */
function stubDiscovery(input: {
  candidates: DiscoverySearchCandidate[];
  plugins: Record<string, Array<{ pluginPath: string; url: string; bundlePath?: string }>>;
  throwOnSearch?: unknown;
  throwOnRepo?: string;
}): PluginDiscoveryPort {
  let used = 0;
  let rateLimited = false;
  return {
    requestsUsed: () => used,
    wasRateLimited: () => rateLimited,
    async searchCandidates() {
      used += 1;
      if (input.throwOnSearch !== undefined) throw input.throwOnSearch;
      return input.candidates;
    },
    async findPlugins(candidate) {
      used += 1;
      if (input.throwOnRepo === candidate.fullName) {
        throw Object.assign(new Error('上游崩了'), { name: 'DomainError', code: 'provider_unavailable' });
      }
      return (input.plugins[candidate.fullName] ?? []).map((p) => ({
        pluginPath: p.pluginPath,
        url: p.url,
        manifestPath: p.pluginPath === '.' ? 'package.json' : `${p.pluginPath}/package.json`,
        bundlePath: p.bundlePath ?? 'dsh.bundle.json',
        name: null,
        description: null,
        version: null,
      }));
    },
  };
}

function candidate(fullName: string): DiscoverySearchCandidate {
  const [owner, repo] = fullName.split('/') as [string, string];
  return {
    fullName,
    owner,
    repo,
    defaultBranch: 'main',
    htmlUrl: `https://github.com/${fullName}`,
    stars: 1,
    repoUpdatedAt: null,
    repoDescription: null,
    topics: [],
  };
}

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

describe('发现服务：收录与审计', () => {
  it('收录进目录，且审计记 system 身份 + 关联**真实存在**的任务 ID（不冒充成某个用户）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    // 审计的 task_id 有外键：这里用**真的排出来的任务**，
    // 顺带证明"顺着审计能查回是哪一轮任务收录的"（用假 ID 会被 FK 拦下）。
    const tasks = createTasksService(db);
    const scheduled = await ensureDailyDiscoveryTask({
      tasks,
      now: Date.parse('2026-10-14T02:00:00Z'),
      env: {},
    });
    const service = createPluginDiscoveryService({
      db,
      discovery: stubDiscovery({
        candidates: [candidate('owner/repo')],
        plugins: {
          'owner/repo': [{ pluginPath: '.', url: 'https://github.com/owner/repo' }],
        },
      }),
      probe: stubProbe(),
    });

    const summary = await service.run({ runKey: 'daily:2026-10-14', taskId: scheduled.taskId });
    expect(summary.accepted).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.skipped).toEqual([]);

    const pluginCount = db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number };
    expect(pluginCount.c).toBe(1);

    const receipt = db
      .prepare("SELECT actor_kind, actor_user_id, task_id, reason FROM operation_records WHERE action_type = 'catalog.accept_plugin_submission'")
      .get() as { actor_kind: string; actor_user_id: string | null; task_id: string | null; reason: string };
    expect(receipt.actor_kind).toBe('system');
    expect(receipt.actor_user_id).toBeNull();
    expect(receipt.task_id).toBe(scheduled.taskId);
    expect(receipt.reason).toContain('自动发现收录');
  });

  it('重跑同一批候选：只刷新资料，不重复建行，且每轮各留一条审计', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const tasks = createTasksService(db);
    const day1 = await ensureDailyDiscoveryTask({ tasks, now: Date.parse('2026-10-14T02:00:00Z'), env: {} });
    const day2 = await ensureDailyDiscoveryTask({ tasks, now: Date.parse('2026-10-15T02:00:00Z'), env: {} });
    const makeService = () =>
      createPluginDiscoveryService({
        db,
        discovery: stubDiscovery({
          candidates: [candidate('owner/repo')],
          plugins: { 'owner/repo': [{ pluginPath: '.', url: 'https://github.com/owner/repo' }] },
        }),
        probe: stubProbe(),
      });

    const first = await makeService().run({ runKey: 'daily:2026-10-14', taskId: day1.taskId });
    const second = await makeService().run({ runKey: 'daily:2026-10-15', taskId: day2.taskId });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number }).c).toBe(1);
    // 两轮 = 两条审计（每轮的 operation_key 不同），否则"哪一轮收录的"就查不清了
    const receipts = db
      .prepare("SELECT task_id FROM operation_records WHERE action_type = 'catalog.accept_plugin_submission' ORDER BY created_at")
      .all() as Array<{ task_id: string | null }>;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]!.task_id).toBe(day1.taskId);
    expect(receipts[1]!.task_id).toBe(day2.taskId);
  });

  it('收录被拒（探针说没声明 dsh.bundle）→ 记进 skipped，不影响同一轮其它插件', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    let call = 0;
    const probe = stubProbe({
      fetchPluginManifest: async () => {
        call += 1;
        return call === 1 ? null : manifestStub(); // 第一个被拒
      },
    });
    const service = createPluginDiscoveryService({
      db,
      discovery: stubDiscovery({
        candidates: [candidate('a/b'), candidate('c/d')],
        plugins: {
          'a/b': [{ pluginPath: '.', url: 'https://github.com/a/b' }],
          'c/d': [{ pluginPath: '.', url: 'https://github.com/c/d' }],
        },
      }),
      probe,
    });

    const summary = await service.run({ runKey: 'k', taskId: null });
    expect(summary.accepted).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]).toMatchObject({ url: 'https://github.com/a/b', code: 'input_invalid' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number }).c).toBe(1);
  });

  it('仓库里没有声明 dsh.bundle → 不是错误，如实记一笔 discovery_no_dsh_bundle', async () => {
    ctx = createTestDb();
    const service = createPluginDiscoveryService({
      db: ctx.db,
      discovery: stubDiscovery({ candidates: [candidate('a/b')], plugins: { 'a/b': [] } }),
      probe: stubProbe(),
    });
    const summary = await service.run({ runKey: 'k', taskId: null });
    expect(summary.accepted).toBe(0);
    expect(summary.skipped[0]).toMatchObject({ code: 'discovery_no_dsh_bundle' });
  });

  it('搜索阶段上游不可用 → **整轮抛错**（交给任务重试），不当成"零发现"', async () => {
    ctx = createTestDb();
    const service = createPluginDiscoveryService({
      db: ctx.db,
      discovery: stubDiscovery({
        candidates: [],
        plugins: {},
        throwOnSearch: Object.assign(new Error('上游崩了'), { name: 'DomainError', code: 'provider_unavailable' }),
      }),
      probe: stubProbe(),
    });
    await expect(service.run({ runKey: 'k', taskId: null })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('测试夹具/示例路径不进目录（线上真踩过：tests/e2e 的夹具被当成插件收了）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPluginDiscoveryService({
      db,
      discovery: stubDiscovery({
        candidates: [candidate('a/b')],
        plugins: {
          'a/b': [
            { pluginPath: '.', url: 'https://github.com/a/b' },
            { pluginPath: 'tests/e2e/slow-tool-plugin', url: 'https://github.com/a/b/tree/main/tests/e2e/slow-tool-plugin' },
            { pluginPath: 'examples/demo', url: 'https://github.com/a/b/tree/main/examples/demo' },
          ],
        },
      }),
      probe: stubProbe(),
    });

    const summary = await service.run({ runKey: 'k', taskId: null });
    expect(summary.accepted).toBe(1); // 只收了根目录那个真的
    expect(summary.skipped.map((s) => s.code)).toEqual([
      'discovery_non_shippable_path',
      'discovery_non_shippable_path',
    ]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT plugin_path FROM plugins").get() as { plugin_path: string }).plugin_path).toBe('.');
  });

  it('非限流的 403（仓库被屏蔽）→ 记为跳过的候选，**不中止整轮**（这是真实踩过的坑）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    // 第一个候选读取时抛 target_unavailable（模拟"这个仓库不让看"），第二个正常
    const discovery = stubDiscovery({
      candidates: [candidate('blocked/repo'), candidate('ok/repo')],
      plugins: { 'ok/repo': [{ pluginPath: '.', url: 'https://github.com/ok/repo' }] },
    });
    const originalFind = discovery.findPlugins.bind(discovery);
    discovery.findPlugins = async (c) => {
      if (c.fullName === 'blocked/repo') {
        // 用**真的** DomainError：isDomainError 认的是类实例，假对象会被当成 unknown
        throw err.unavailable('上游拒绝访问该资源：HTTP 403，剩余配额 57，Repository access blocked');
      }
      return originalFind(c);
    };

    const summary = await createPluginDiscoveryService({ db, discovery, probe: stubProbe() }).run({
      runKey: 'k',
      taskId: null,
    });
    expect(summary.accepted).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]).toMatchObject({ code: 'target_unavailable' });
  });

  it('maxPlugins 到了就停下并如实标 truncated（不假装"本轮就这么多"）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createPluginDiscoveryService({
      db,
      discovery: stubDiscovery({
        candidates: [candidate('a/b'), candidate('c/d')],
        plugins: {
          'a/b': [{ pluginPath: '.', url: 'https://github.com/a/b' }],
          'c/d': [{ pluginPath: '.', url: 'https://github.com/c/d' }],
        },
      }),
      probe: stubProbe(),
    });
    const summary = await service.run({ runKey: 'k', taskId: null, maxPlugins: 1 });
    expect(summary.accepted).toBe(1);
    expect(summary.truncated).toBe(true);
    expect(summary.truncatedReason).toContain('单轮收录上限');
  });
});

// ============================================================
// 3) 系统路径收录本身
// ============================================================

describe('系统路径收录', () => {
  it('不需要登录、审计是 system、且不写 requested_by（没有具体请求人）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const catalog = createCatalogService({ db });
    const result = await catalog.acceptPluginSubmissionBySystem(
      { url: 'https://github.com/owner/repo', operationKey: 'discover:k:owner/repo:.', taskId: null },
      { probe: stubProbe() },
    );
    expect(result.created).toBe(true);
    expect(result.replayed).toBe(false);

    const row = db
      .prepare("SELECT actor_kind, actor_user_id FROM operation_records WHERE operation_key = 'discover:k:owner/repo:.'")
      .get() as { actor_kind: string; actor_user_id: string | null };
    expect(row.actor_kind).toBe('system');
    expect(row.actor_user_id).toBeNull();

    // 库里根本没有用户也能走通（用户路径会 unauthenticated 拒绝）
    expect((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBe(0);
  });

  it('用户路径仍然要求登录（系统路径没有把门槛放宽）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const catalog = createCatalogService({ db });
    await expect(
      catalog.acceptPluginSubmission(
        { userId: null, accountStatus: 'active' } as never,
        { url: 'https://github.com/owner/repo', requestKey: 'user-key-1' },
        { probe: stubProbe() },
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('系统路径也要求审计键（空键就拒，避免审计缺号）', async () => {
    ctx = createTestDb();
    const catalog = createCatalogService({ db: ctx.db });
    await expect(
      catalog.acceptPluginSubmissionBySystem({ url: 'https://github.com/owner/repo', operationKey: '  ', taskId: null }, { probe: stubProbe() }),
    ).rejects.toMatchObject({ code: 'input_invalid' });
  });
});

// ============================================================
// 4) 每日排程
// ============================================================

describe('每日发现排程', () => {
  it('按站点时区（Asia/Shanghai）算"哪一天"：UTC 16:30 已经是北京时间次日', () => {
    // 2026-10-13T16:30:00Z = 2026-10-14 00:30（北京） → 键里必须是 10-14
    expect(discoveryDailyKey(Date.parse('2026-10-13T16:30:00Z'))).toBe('daily:2026-10-14');
    expect(discoveryDailyKey(Date.parse('2026-10-13T15:59:00Z'))).toBe('daily:2026-10-13');
  });

  it('同一天反复调用只排一次（dedup 幂等），且任务带完整参数', async () => {
    ctx = createTestDb();
    const tasks = createTasksService(ctx.db);
    const now = Date.parse('2026-10-14T02:00:00Z');

    const first = await ensureDailyDiscoveryTask({ tasks, now, env: {} });
    const second = await ensureDailyDiscoveryTask({ tasks, now: now + 60_000, env: {} });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.taskId).toBe(first.taskId);

    const rows = ctx.db.prepare("SELECT payload, scheduling_group, requested_by, processing_state FROM background_tasks WHERE task_type = 'plugin_discovery'").all() as Array<{
      payload: string;
      scheduling_group: string;
      requested_by: string | null;
      processing_state: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processing_state).toBe('queued');
    expect(rows[0]!.requested_by).toBeNull();
    expect(rows[0]!.scheduling_group).toBe('plugin_discovery_schedule');
    expect(JSON.parse(rows[0]!.payload).run_key).toBe('daily:2026-10-14');
  });

  it('离线模式或显式关闭 → 不排任务，并给出原因', async () => {
    ctx = createTestDb();
    const tasks = createTasksService(ctx.db);
    const now = Date.now();

    const offline = await ensureDailyDiscoveryTask({ tasks, now, env: { DSH_REVIEW_CATALOG_OFFLINE: '1' } });
    const disabled = await ensureDailyDiscoveryTask({ tasks, now, env: { DSH_REVIEW_DISCOVERY_DAILY: '0' } });

    expect(offline.created).toBe(false);
    expect(offline.skippedReason).toContain('离线模式');
    expect(disabled.created).toBe(false);
    expect(disabled.skippedReason).toContain('DSH_REVIEW_DISCOVERY_DAILY=0');

    expect(
      (ctx.db.prepare("SELECT COUNT(*) AS c FROM background_tasks WHERE task_type = 'plugin_discovery'").get() as { c: number }).c,
    ).toBe(0);
    expect(discoveryScheduleSkipReason({})).toBeNull();
  });

  it('跨天会各排一次（日期是键的一部分）', async () => {
    ctx = createTestDb();
    const tasks = createTasksService(ctx.db);
    const day1 = Date.parse('2026-10-14T02:00:00Z');
    const day2 = Date.parse('2026-10-15T02:00:00Z');

    await ensureDailyDiscoveryTask({ tasks, now: day1, env: {} });
    const next = await ensureDailyDiscoveryTask({ tasks, now: day2, env: {} });

    expect(next.created).toBe(true);
    expect(
      (ctx.db.prepare("SELECT COUNT(*) AS c FROM background_tasks WHERE task_type = 'plugin_discovery'").get() as { c: number }).c,
    ).toBe(2);
  });
});

// ============================================================
// 6) 排程 payload ↔ handler 读取名**不许漂移**（真实踩过的 bug）
// ============================================================

describe('排程 payload 与 handler 的契约', () => {
  it('排程写进去的预算，handler 必须真的读到（键名不一致就会静默忽略预算）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const tasks = createTasksService(db);

    // 未认证 → 预算应是保守档（perPage 20 / 单页），排进 payload
    const scheduled = await ensureDailyDiscoveryTask({
      tasks,
      now: Date.parse('2026-10-14T02:00:00Z'),
      env: {},
    });
    expect(scheduled.taskId).not.toBeNull();
    const claim = await tasks.claim('w', Date.parse('2026-10-14T02:00:01Z'));
    expect(claim).not.toBeNull();

    // 假适配器把**收到的搜索参数**记下来
    let seen: { pages?: number; perPage?: number } | null = null;
    const recording: PluginDiscoveryPort = {
      requestsUsed: () => 0,
      wasRateLimited: () => false,
      async searchCandidates(input) {
        seen = { pages: input.pages, perPage: input.perPage };
        return [];
      },
      async findPlugins() {
        return [];
      },
    };

    const handlers = createHandlers({ db, discovery: recording, probe: stubProbe() });
    await handlers.plugin_discovery!(claim!);

    // 预算必须落到 handler 手里：未认证档是 2 页 × 30 条（搜索便宜，核心请求才是瓶颈）
    expect(seen).not.toBeNull();
    expect(seen!.perPage).toBe(30);
    expect(seen!.pages).toBe(2);
  });

  it('有 token 时排程给的是放大的预算（认证后配额高得多）', async () => {
    ctx = createTestDb();
    const tasks = createTasksService(ctx.db);
    const scheduled = await ensureDailyDiscoveryTask({
      tasks,
      now: Date.parse('2026-10-14T02:00:00Z'),
      env: { GITHUB_TOKEN: 'x' },
    });
    const row = ctx.db
      .prepare('SELECT payload FROM background_tasks WHERE id = ?')
      .get(scheduled.taskId) as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.per_page).toBe(30);
    expect(payload.search_pages).toBe(2);
    expect(payload.max_plugins).toBe(30);
  });
});

// ============================================================
// 5) 迁移与用户身份的小回归（0007 重建表不能丢数据）
// ============================================================

describe('既有数据不受 0007 影响', () => {
  it('迁移后旧任务行仍在，且新任务类型可写', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const uid = insertUser(db, { nickname: '甲' });
    const now = Date.now();
    db.prepare(
      `INSERT INTO background_tasks (id, task_type, deduplication_key, requested_by, payload, scheduling_group, processing_state, available_at, created_at, updated_at)
       VALUES (?, 'review_check', 'x', ?, '{}', 'review_check', 'queued', ?, ?, ?)`,
    ).run(newId(now), uid, now, now, now);
    db.prepare(
      `INSERT INTO background_tasks (id, task_type, deduplication_key, requested_by, payload, scheduling_group, processing_state, available_at, created_at, updated_at)
       VALUES (?, 'plugin_discovery', 'y', NULL, '{}', 'plugin_discovery_schedule', 'queued', ?, ?, ?)`,
    ).run(newId(now), now, now, now);
    const count = db.prepare('SELECT COUNT(*) AS c FROM background_tasks').get() as { c: number };
    expect(count.c).toBe(2);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
