/**
 * 真实 GitHub 收录探针测试（工作包 GF，task-5）。
 *
 * 纪律：
 *  - **不出网**：`fetch` 与 `env` 全部注入，任何真实网络调用都会因断言失败暴露；
 *  - 断言必须能咬住实现（改坏 base64 解码 → 本文件必须变红）；
 *  - 每条用例都构造**真实 GitHub 响应形状**的 JSON（含 `content` 的换行、数字 id、archived 布尔）。
 */

import { describe, expect, it } from 'vitest';
import { isDomainError } from '@/packages/common/errors';
import {
  createGithubCatalogProbe,
  decodeBase64Utf8,
  extractBundlePatchPath,
  resolveBundleRepoPath,
} from '@/server/adapters/catalog/github-probe';

const OWNER = 'owner';
const REPO = 'repo';

/** 记录调用过的 URL，用于断言"没有发多余的请求"以及路径拼接正确。 */
interface StubCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * 构造打桩 fetch。
 * @param routes 以「url 的 pathname 后缀」为键的响应工厂；未命中即 404，并记录调用。
 */
function makeStub(routes: Record<string, () => Response>, calls: StubCall[] = []) {
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    for (const [suffix, factory] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return factory();
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  return { fetchImpl, calls };
}

/** 真实形状：GitHub 的 content 是 base64 且每 60 字符插入换行。 */
function base64WithNewlines(text: string): string {
  const raw = Buffer.from(text, 'utf8').toString('base64');
  return raw.replace(/(.{60})/g, '$1\n');
}

function contentsFile(text: string) {
  return new Response(
    JSON.stringify({
      name: 'package.json',
      path: 'package.json',
      sha: 'abc123',
      size: Buffer.byteLength(text, 'utf8'),
      type: 'file',
      encoding: 'base64',
      content: base64WithNewlines(text),
    }),
    { status: 200 },
  );
}

function repoResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: 123456789,
      full_name: `${OWNER}/${REPO}`,
      html_url: `https://github.com/${OWNER}/${REPO}`,
      archived: false,
      ...overrides,
    }),
    { status: 200 },
  );
}

/** 探针只按需读取少数几个环境变量；用一个宽松的映射避免依赖 NodeJS.ProcessEnv 的必填字段。 */
type ProbeEnv = Record<string, string | undefined>;

const OFFLINE_OFF: ProbeEnv = {};

describe('decodeBase64Utf8：必须按 UTF-8 还原（经典坑）', () => {
  it('含中文与换行的 base64 能正确还原（不是 Latin-1 乱码）', () => {
    const original = '{\n  "name": "插件",\n  "描述": "中文内容 😀"\n}';
    const encoded = base64WithNewlines(original);
    const decoded = decodeBase64Utf8(encoded);

    expect(decoded).toBe(original);
    // 咬住"忘了按 utf-8 解码"的实现：Latin-1 还原会得到截然不同的字符。
    expect(decoded).toContain('插件');
    expect(decoded).toContain('😀');
    expect(decoded).not.toContain('Ã');
  });

  it('还原结果可被 JSON.parse 且字段值正确（端到端咬合）', () => {
    const obj = { name: 'dsh-测试插件', dsh: { bundle: { patch: './cordis.patch.yml' } } };
    const decoded = JSON.parse(decodeBase64Utf8(base64WithNewlines(JSON.stringify(obj)))) as typeof obj;
    expect(decoded.name).toBe('dsh-测试插件');
    expect(decoded.dsh.bundle.patch).toBe('./cordis.patch.yml');
  });

  it('剥掉 GitHub 注入的换行：带换行与不带换行解出同一结果', () => {
    const text = 'x'.repeat(200) + '中文';
    const withNl = base64WithNewlines(text);
    const withoutNl = Buffer.from(text, 'utf8').toString('base64');
    expect(withNl).toContain('\n');
    expect(decodeBase64Utf8(withNl)).toBe(decodeBase64Utf8(withoutNl));
  });

  it('剥换行对**每一位**都成立：逐字符破坏 base64 分组仍解回原文', () => {
    // 换行若插在 4 字符组的中间会破坏解码；这里用奇数长度的重复，让换行必然落在组内，
    // 从而证明"先剥空白"不是可选项（Buffer 容忍空白，但显式剥离能覆盖换行插入位置任意的情况）。
    const text = '中文😀' + 'a'.repeat(37) + '尾部';
    const raw = Buffer.from(text, 'utf8').toString('base64');
    for (const groupSize of [1, 2, 3, 5, 60]) {
      const mangled = raw.replace(new RegExp(`(.{${groupSize}})`, 'g'), '$1\n');
      expect(decodeBase64Utf8(mangled)).toBe(text);
    }
  });
});

describe('extractBundlePatchPath：dsh.bundle 的真实形状是对象', () => {
  it('对象 patch 字符串 → 取路径', () => {
    expect(extractBundlePatchPath({ patch: './cordis.patch.yml' })).toBe('./cordis.patch.yml');
  });

  it('对象 patch 数组（上游支持有序列表）→ 取首条', () => {
    expect(extractBundlePatchPath({ patch: ['./base.patch.yml', './web.patch.yml'] })).toBe('./base.patch.yml');
  });

  it('字符串直给（宽松形态）→ 取该字符串', () => {
    expect(extractBundlePatchPath('./cordis.patch.yml')).toBe('./cordis.patch.yml');
  });

  it('空声明一律返回 null（不把空串当成有效路径）', () => {
    expect(extractBundlePatchPath({})).toBeNull();
    expect(extractBundlePatchPath({ patch: '' })).toBeNull();
    expect(extractBundlePatchPath({ patch: '   ' })).toBeNull();
    expect(extractBundlePatchPath({ patch: [] })).toBeNull();
    expect(extractBundlePatchPath(null)).toBeNull();
    expect(extractBundlePatchPath(42)).toBeNull();
  });
});

describe('resolveBundleRepoPath：锚点是声明它的 package.json 所在目录', () => {
  it('根插件 + ./x → 仓库根下 x', () => {
    expect(resolveBundleRepoPath('.', './cordis.patch.yml')).toBe('cordis.patch.yml');
  });

  it('子目录插件 + ./x → 拼接 pluginPath（不是仓库根）', () => {
    expect(resolveBundleRepoPath('packages/foo', './cordis.patch.yml')).toBe('packages/foo/cordis.patch.yml');
  });

  it('前导 / 视为仓库根锚点', () => {
    expect(resolveBundleRepoPath('packages/foo', '/shared/base.patch.yml')).toBe('shared/base.patch.yml');
  });

  it('../ 归并到父级，且绝不越出仓库根', () => {
    expect(resolveBundleRepoPath('packages/foo', '../base.patch.yml')).toBe('packages/base.patch.yml');
    expect(resolveBundleRepoPath('.', '../../escape.yml')).toBe('escape.yml');
    expect(resolveBundleRepoPath('a', '../../escape.yml')).toBe('escape.yml');
  });
});

describe('fetchRepository', () => {
  it('正常仓库 → 数字 id 转字符串，字段如实透传', async () => {
    const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse() });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });

    const info = await probe.fetchRepository({ owner: OWNER, repo: REPO });
    expect(info.githubRepositoryId).toBe('123456789');
    expect(typeof info.githubRepositoryId).toBe('string');
    expect(info.fullName).toBe(`${OWNER}/${REPO}`);
    expect(info.htmlUrl).toBe(`https://github.com/${OWNER}/${REPO}`);
    expect(info.isArchived).toBe(false);
  });

  it('archived: true → isArchived 为 true（业务据此拒绝收录）', async () => {
    const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse({ archived: true }) });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    expect((await probe.fetchRepository({ owner: OWNER, repo: REPO })).isArchived).toBe(true);
  });

  it('仓库 404 → input_invalid（用户输入问题，不给"私有存在与否"的信息）', async () => {
    const { fetchImpl } = makeStub({});
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });

    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'input_invalid',
    );
  });

  it('请求头符合 GitHub 要求；无 token 时不带 authorization', async () => {
    const calls: StubCall[] = [];
    const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse() }, calls);
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await probe.fetchRepository({ owner: OWNER, repo: REPO });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}`);
    expect(calls[0]?.headers.accept).toBe('application/vnd.github+json');
    expect(calls[0]?.headers['user-agent']).toBe('dsh-plugin-reviews');
    expect(calls[0]?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('有 GITHUB_TOKEN 时带 Bearer（提高限流额度）', async () => {
    const calls: StubCall[] = [];
    const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse() }, calls);
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: { GITHUB_TOKEN: 'ghp_secret' } });
    await probe.fetchRepository({ owner: OWNER, repo: REPO });
    expect(calls[0]?.headers.authorization).toBe('Bearer ghp_secret');
  });

  it('【对照】没有 token 不算"未配置"，公开仓库照样能读', async () => {
    const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse() });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: {} });
    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).resolves.toBeDefined();
  });

  it('403 限流 → provider_unavailable，且带上 GitHub 的 message', async () => {
    const { fetchImpl } = makeStub({
      [`/repos/${OWNER}/${REPO}`]: () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }), { status: 403 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });

    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).rejects.toSatisfy(
      (e: unknown) =>
        isDomainError(e) && e.code === 'provider_unavailable' && /rate limit exceeded/.test(e.message),
    );
  });

  it('429 限流同样 → provider_unavailable', async () => {
    const { fetchImpl } = makeStub({
      [`/repos/${OWNER}/${REPO}`]: () => new Response(JSON.stringify({ message: 'too many requests' }), { status: 429 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('网络异常 → provider_unavailable（绝不伪装成"仓库不存在"）', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('响应缺少数字 id → provider_unavailable（不拿仓库名冒充稳定身份）', async () => {
    const { fetchImpl } = makeStub({
      [`/repos/${OWNER}/${REPO}`]: () =>
        new Response(JSON.stringify({ full_name: `${OWNER}/${REPO}`, html_url: 'https://github.com/o/r' }), { status: 200 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });
});

describe('fetchPluginManifest', () => {
  const MANIFEST = JSON.stringify({ name: 'dsh-foo', dsh: { bundle: { patch: './cordis.patch.yml' } } });

  it('正常：声明 dsh.bundle + 引用文件存在 → bundleExists true，路径相对 pluginPath', async () => {
    const calls: StubCall[] = [];
    const { fetchImpl } = makeStub(
      {
        [`/contents/packages/foo/package.json`]: () => contentsFile(MANIFEST),
        [`/contents/packages/foo/cordis.patch.yml`]: () => new Response(JSON.stringify({ type: 'file' }), { status: 200 }),
      },
      calls,
    );
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });

    const manifest = await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: 'packages/foo' });
    expect(manifest).toEqual({ bundlePath: 'packages/foo/cordis.patch.yml', bundleExists: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/contents/packages/foo/cordis.patch.yml`);
  });

  it('根插件：package.json 在仓库根，bundlePath 也相对仓库根', async () => {
    const calls: StubCall[] = [];
    const { fetchImpl } = makeStub(
      {
        [`/contents/package.json`]: () => contentsFile(MANIFEST),
        [`/contents/cordis.patch.yml`]: () => new Response(JSON.stringify({ type: 'file' }), { status: 200 }),
      },
      calls,
    );
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    const manifest = await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' });
    expect(manifest).toEqual({ bundlePath: 'cordis.patch.yml', bundleExists: true });
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/contents/package.json`);
  });

  it('声明了但 bundle 文件 404 → bundleExists false（路径仍如实返回）', async () => {
    const { fetchImpl } = makeStub({ [`/contents/packages/foo/package.json`]: () => contentsFile(MANIFEST) });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    const manifest = await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: 'packages/foo' });
    expect(manifest).toEqual({ bundlePath: 'packages/foo/cordis.patch.yml', bundleExists: false });
  });

  it('package.json 不存在（404）→ null（收录检查失败）', async () => {
    const { fetchImpl } = makeStub({});
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    expect(await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: 'packages/foo' })).toBeNull();
  });

  it('package.json 但没有 dsh.bundle 声明 → null', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(JSON.stringify({ name: 'plain-lib' })),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    expect(await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).toBeNull();
  });

  it('package.json 不是合法 JSON → null（不是服务器故障）', async () => {
    const { fetchImpl } = makeStub({ [`/contents/package.json`]: () => contentsFile('{ this is not json') });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    expect(await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).toBeNull();
  });

  it('声明了 dsh.bundle 但 patch 路径为空 → bundlePath 为空串 + false（交由业务报"声明为空"）', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(JSON.stringify({ name: 'x', dsh: { bundle: {} } })),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    expect(await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).toEqual({
      bundlePath: '',
      bundleExists: false,
    });
  });

  it('中文清单能正确解析出 dsh.bundle（base64 UTF-8 端到端）', async () => {
    const cn = JSON.stringify({ name: 'dsh-中文插件', 描述: '含中文', dsh: { bundle: { patch: './补丁.yml' } } });
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(cn),
      [`/contents/${encodeURIComponent('补丁.yml')}`]: () => new Response(JSON.stringify({ type: 'file' }), { status: 200 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    const manifest = await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' });
    expect(manifest?.bundlePath).toBe('补丁.yml');
    expect(manifest?.bundleExists).toBe(true);
  });

  it('bundle 路径指向目录（数组响应）→ bundleExists false（patch 必须是文件）', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(MANIFEST),
      [`/contents/cordis.patch.yml`]: () => new Response(JSON.stringify([{ type: 'dir' }]), { status: 200 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    const manifest = await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' });
    expect(manifest?.bundleExists).toBe(false);
  });

  it('读取 package.json 时 403 限流 → provider_unavailable（不误报"没有声明"）', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 403 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('校验 bundle 文件时 403 限流 → provider_unavailable', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(MANIFEST),
      [`/contents/cordis.patch.yml`]: () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 403 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('校验 bundle 文件时 403 限流带上 GitHub message（不静默吞掉原因）', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(MANIFEST),
      [`/contents/cordis.patch.yml`]: () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded for installation.' }), { status: 403 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && /rate limit exceeded/.test(e.message),
    );
  });

  it('校验 bundle 文件时 429 限流 → provider_unavailable', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(MANIFEST),
      [`/contents/cordis.patch.yml`]: () => new Response(JSON.stringify({ message: 'too many requests' }), { status: 429 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('读取 package.json 时 500 → provider_unavailable（服务器故障不能当成"没声明"）', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => new Response(JSON.stringify({ message: 'server error' }), { status: 500 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('校验 bundle 文件时 500 → provider_unavailable', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () => contentsFile(MANIFEST),
      [`/contents/cordis.patch.yml`]: () => new Response(JSON.stringify({ message: 'server error' }), { status: 500 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  it('encoding 非 base64（大文件 GitHub 返回 none）→ null，不猜内容', async () => {
    const { fetchImpl } = makeStub({
      [`/contents/package.json`]: () =>
        new Response(JSON.stringify({ type: 'file', encoding: 'none', size: 2_000_000 }), { status: 200 }),
    });
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: OFFLINE_OFF });
    expect(await probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).toBeNull();
  });
});

describe('离线开关：DSH_REVIEW_CATALOG_OFFLINE=1 → provider_not_configured', () => {
  it('离线时 fetchRepository 抛 provider_not_configured 且**不发任何请求**', async () => {
    const calls: StubCall[] = [];
    const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse() }, calls);
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: { DSH_REVIEW_CATALOG_OFFLINE: '1' } });

    await expect(probe.fetchRepository({ owner: OWNER, repo: REPO })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_not_configured',
    );
    expect(calls).toHaveLength(0);
  });

  it('离线时 fetchPluginManifest 抛 provider_not_configured', async () => {
    const calls: StubCall[] = [];
    const { fetchImpl } = makeStub({ [`/contents/package.json`]: () => contentsFile(MANIFEST_JSON) }, calls);
    const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: { DSH_REVIEW_CATALOG_OFFLINE: '1' } });

    await expect(probe.fetchPluginManifest({ owner: OWNER, repo: REPO, pluginPath: '.' })).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === 'provider_not_configured',
    );
    expect(calls).toHaveLength(0);
  });

  it('【对照】OFFLINE 非精确 "1"（如 "0"/"true"）不触发离线，仍走真实请求', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
      const calls: StubCall[] = [];
      const { fetchImpl } = makeStub({ [`/repos/${OWNER}/${REPO}`]: () => repoResponse() }, calls);
      const probe = createGithubCatalogProbe({ fetch: fetchImpl, env: { DSH_REVIEW_CATALOG_OFFLINE: value } });
      await probe.fetchRepository({ owner: OWNER, repo: REPO });
      expect(calls).toHaveLength(1);
    }
  });
});

const MANIFEST_JSON = JSON.stringify({ name: 'dsh-foo', dsh: { bundle: { patch: './cordis.patch.yml' } } });

describe('注入边界：本测试文件绝不出网', () => {
  it('未注入 fetch 时会用 globalThis.fetch —— 因此每处都显式注入（对照：全局被打桩也能证明）', async () => {
    const original = globalThis.fetch;
    let globalCalled = 0;
    globalThis.fetch = (async () => {
      globalCalled += 1;
      return repoResponse();
    }) as typeof globalThis.fetch;
    try {
      const probe = createGithubCatalogProbe({ env: OFFLINE_OFF });
      await probe.fetchRepository({ owner: OWNER, repo: REPO });
      // 证明"省略 fetch 会走全局"，这正是我们坚持显式注入的原因。
      expect(globalCalled).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
