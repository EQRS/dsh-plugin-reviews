/**
 * 插件目录的**自动发现**适配器：从 GitHub 找"值得收录的 DSH 插件"。
 *
 * 与 `github-probe.ts` 的分工（刻意分开，别混）：
 *   * **probe** = 收录检查的权威判定，面向**用户的一次提交**：单次请求、失败即报，
 *     不重试（重试会让"仓库不存在"这种确定性答案变慢，也污染请求计数断言）；
 *   * **discovery** = 面向**后台定时任务**：允许**重试 + 退避**（出网偶发断流不能让一天的发现任务白跑），
 *     并且**自带请求计数**，好让服务层守住上游预算。
 *
 * 本文件只做"找候选"与"读清单"，**不做收录判定**：
 * 仓库是否可访问、归档没有、`dsh.bundle` 引用的文件在不在，一律由 catalog 服务的
 * 收录检查（走 probe）最终裁定 —— 发现说"看这个"，收录说"行不行"，两者不互相冒充。
 */

import { err } from '@/packages/common/errors';
import { decodeBase64Utf8 } from './github-probe';

/** 环境视图：只声明这里用得到的键，测试可传最小对象。 */
export interface DiscoveryEnvView {
  GITHUB_TOKEN?: string;
  DSH_REVIEW_CATALOG_OFFLINE?: string;
  [key: string]: string | undefined;
}

export interface GithubDiscoveryDeps {
  fetch?: typeof globalThis.fetch;
  env?: DiscoveryEnvView;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 失败后的**重试次数**（不含首次）。默认 2 → 最多 3 次尝试。 */
  retries?: number;
  /** 退避基数（毫秒）：第 n 次重试等 base * 2^(n-1)。 */
  backoffMs?: number;
  /** 等待实现，测试注入以便不真的睡。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 搜索出来的候选仓库（还没核到插件本体）。 */
export interface DiscoverySearchCandidate {
  fullName: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  htmlUrl: string;
  stars: number;
  repoUpdatedAt: number | null;
  repoDescription: string | null;
  topics: string[];
}

/** 候选仓库里"声明了 dsh.bundle"的一个插件路径。 */
export interface DiscoveredPluginPath {
  /** 仓库内目录（根目录为 '.'，与 catalog 的 pluginPath 归一规则一致）。 */
  pluginPath: string;
  /** 可直接提交收录的 URL（根目录给仓库首页，子目录给 tree/<branch>/<dir>）。 */
  url: string;
  /** package.json 的仓库内路径（便于排障）。 */
  manifestPath: string;
  /** dsh.bundle 指到的配置文件（仓库内路径）。 */
  bundlePath: string;
  name: string | null;
  description: string | null;
  version: string | null;
}

export interface PluginDiscoveryPort {
  searchCandidates(input: { query: string; pages?: number; perPage?: number }): Promise<DiscoverySearchCandidate[]>;
  findPlugins(
    candidate: DiscoverySearchCandidate,
    opts?: { verifyPatch?: boolean },
  ): Promise<DiscoveredPluginPath[]>;
  /** 本实例累计发出的上游请求数（服务层用它守预算）。 */
  requestsUsed(): number;
  /**
   * 本实例是否**撞上过上游限流**（403/429）。
   *
   * 为什么单独暴露它：未认证访问 GitHub 时核心接口只有 **60 次/小时**（认证后 5000 次/小时），
   * 撞上以后重试没用。服务层据此**干净收尾**（保住本轮已收录的，记下原因），
   * 而不是把整轮当故障丢掉重来 —— 那样会把已经花掉的配额白扔掉。
   */
  wasRateLimited(): boolean;
}

const API_BASE = 'https://api.github.com';

/** 发现任务的上游超时：比用户路径的 15 秒更长（后台任务不催，宁可等）。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 单个仓库最多读多少个 package.json，避免 monorepo 把预算吃光。 */
const MAX_MANIFESTS_PER_REPO = 80;

/** GitHub 建议的固定请求头；缺 user-agent 会被 api.github.com 拒绝。 */
function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-reviews-discovery',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 从 dsh.bundle 声明里取 patch 路径（对象取 patch，字符串直接用；数组取首个字符串）。 */
export function bundlePathOf(decl: unknown): string | null {
  if (typeof decl === 'string') {
    const trimmed = decl.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (decl !== null && typeof decl === 'object' && !Array.isArray(decl)) {
    const patch = (decl as { patch?: unknown }).patch;
    if (typeof patch === 'string') {
      const trimmed = patch.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(patch) && typeof patch[0] === 'string') {
      const trimmed = patch[0].trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

/** 把仓库内相对路径按 posix 语义拼接（GitHub 路径永远是 / 分隔，不用 path.join）。 */
function joinRepoPath(dir: string, rel: string): string {
  const clean = rel.replace(/^\.\//, '').replace(/^\/+/, '');
  return dir === '' ? clean : `${dir}/${clean}`;
}

function asTopicList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
}

function asIsoMsOrNull(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function asTextOrNull(v: unknown, maxLength = 2000): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function createGithubPluginDiscovery(deps: GithubDiscoveryDeps = {}): PluginDiscoveryPort {
  const doFetch: typeof globalThis.fetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = deps.retries ?? 2;
  const backoffMs = deps.backoffMs ?? 400;
  const sleep = deps.sleep ?? defaultSleep;

  const token = env.GITHUB_TOKEN?.trim() ?? '';
  const offline = env.DSH_REVIEW_CATALOG_OFFLINE === '1';

  let requests = 0;
  let rateLimited = false;

  function assertOnline(): void {
    if (offline) {
      throw err.notConfigured('已设置 DSH_REVIEW_CATALOG_OFFLINE=1，自动发现被显式禁用，无法访问 GitHub。');
    }
  }

  /**
   * 带超时 + 重试的 GET。
   *
   * 重试判据（**只重试"可能自愈"的失败**）：
   *   * 网络错误 / 超时 → 重试；
   *   * 5xx、429、403（GitHub 限流也是 403）→ 重试；
   *   * 4xx 其他（401/404 等）→ **不重试**：这是确定性答案，重试只会浪费预算。
   * 全部尝试都失败 → `provider_unavailable`，并在消息里带上尝试次数（便于排障时区分"网络抖"与"被限流"）。
   */
  async function getWithRetry(path: string): Promise<Response> {
    assertOnline();
    let lastReason = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${API_BASE}${path}`, {
          method: 'GET',
          headers: buildHeaders(token.length > 0 ? token : null),
          signal: controller.signal,
        });
        if (res.ok) return res;
        const retriable = res.status >= 500 || res.status === 429 || res.status === 403;
        // 限流单独记一笔：服务层要据此**干净收尾**（保住已收录的），而不是把整轮当故障丢重来。
        if (res.status === 403 || res.status === 429) rateLimited = true;
        lastReason = res.status === 403 || res.status === 429 ? `被上游限流（HTTP ${res.status}）` : `HTTP ${res.status}`;
        if (!retriable) {
          throw err.providerDown(`访问 GitHub 失败：${lastReason}。`);
        }
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'DomainError') throw cause; // err.* 已是最终结论
        const isAbort = cause instanceof Error && cause.name === 'AbortError';
        lastReason = isAbort ? `请求超时（${timeoutMs}ms）` : '网络请求失败';
      } finally {
        clearTimeout(timer);
      }
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
    throw err.providerDown(`访问 GitHub 失败：${lastReason}（已重试 ${retries} 次，共 ${retries + 1} 次尝试）。`);
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw err.providerDown('GitHub 返回了无法解析的响应体。');
    }
  }

  /**
   * 允许 404 的取内容：**404 是"这里没有这个文件"**，不是上游故障。
   *
   * 用在"核验 dsh.bundle 指向的文件是否存在"这一步：声明了但文件不在，
   * 语义是"这个候选不成立"（剔除即可），不该让整轮发现因为一个坏声明而失败。
   * 其余状态码（5xx/429/403/网络）仍然按可重试故障处理。
   */
  async function getAllow404(path: string): Promise<Response | null> {
    assertOnline();
    let lastReason = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${API_BASE}${path}`, {
          method: 'GET',
          headers: buildHeaders(token.length > 0 ? token : null),
          signal: controller.signal,
        });
        if (res.ok) return res;
        if (res.status === 404) return null;
        const retriable = res.status >= 500 || res.status === 429 || res.status === 403;
        // 限流单独记一笔：服务层要据此**干净收尾**（保住已收录的），而不是把整轮当故障丢重来。
        if (res.status === 403 || res.status === 429) rateLimited = true;
        lastReason = res.status === 403 || res.status === 429 ? `被上游限流（HTTP ${res.status}）` : `HTTP ${res.status}`;
        if (!retriable) throw err.providerDown(`访问 GitHub 失败：${lastReason}。`);
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'DomainError') throw cause;
        const isAbort = cause instanceof Error && cause.name === 'AbortError';
        lastReason = isAbort ? `请求超时（${timeoutMs}ms）` : '网络请求失败';
      } finally {
        clearTimeout(timer);
      }
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
    throw err.providerDown(`访问 GitHub 失败：${lastReason}（已重试 ${retries} 次，共 ${retries + 1} 次尝试）。`);
  }

  return {
    requestsUsed: () => requests,
    wasRateLimited: () => rateLimited,

    async searchCandidates(input) {
      const pages = Math.max(1, Math.min(input.pages ?? 1, 5));
      const perPage = Math.max(1, Math.min(input.perPage ?? 30, 100));
      const found: DiscoverySearchCandidate[] = [];
      const seen = new Set<string>();

      for (let page = 1; page <= pages; page += 1) {
        const query = `q=${encodeURIComponent(input.query)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`;
        const res = await getWithRetry(`/search/repositories?${query}`);
        const body = (await readJson(res)) as { items?: unknown };
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) break;

        for (const raw of items) {
          const item = raw as Record<string, unknown>;
          const owner = (item.owner as { login?: unknown } | undefined)?.login;
          const name = item.name;
          const fullName = item.full_name;
          if (typeof owner !== 'string' || typeof name !== 'string' || typeof fullName !== 'string') continue;
          // 归档仓库不收录（收了也没法维护）：**在发现阶段就跳过**，省下后续每仓库 1+N 次请求。
          if (item.archived === true) continue;
          if (seen.has(fullName)) continue;
          seen.add(fullName);
          found.push({
            fullName,
            owner,
            repo: name,
            defaultBranch: typeof item.default_branch === 'string' ? item.default_branch : 'main',
            htmlUrl: typeof item.html_url === 'string' ? item.html_url : `https://github.com/${fullName}`,
            stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
            repoUpdatedAt: asIsoMsOrNull(item.updated_at),
            repoDescription: asTextOrNull(item.description),
            topics: asTopicList(item.topics),
          });
        }
      }
      return found;
    },

    async findPlugins(candidate, opts) {
      const verifyPatch = opts?.verifyPatch === true;
      const branch = candidate.defaultBranch;
      const treeRes = await getWithRetry(
        `/repos/${candidate.owner}/${candidate.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      );
      const tree = (await readJson(treeRes)) as { tree?: unknown };
      const nodes = Array.isArray(tree.tree) ? tree.tree : [];

      const manifestPaths = nodes
        .map((n) => n as Record<string, unknown>)
        .filter((n) => n.type === 'blob' && typeof n.path === 'string' && (n.path as string).endsWith('package.json'))
        // node_modules 里的 package.json 不是插件本体（会白烧预算）。
        .filter((n) => !/(^|\/)node_modules\//.test(n.path as string))
        .map((n) => n.path as string)
        .slice(0, MAX_MANIFESTS_PER_REPO);

      const plugins: DiscoveredPluginPath[] = [];
      for (const manifestPath of manifestPaths) {
        const res = await getWithRetry(`/repos/${candidate.owner}/${candidate.repo}/contents/${encodeURIComponent(manifestPath)}`);
        const body = (await readJson(res)) as { content?: unknown };
        if (typeof body.content !== 'string') continue;
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(decodeBase64Utf8(body.content)) as Record<string, unknown>;
        } catch {
          continue;
        }
        const dsh = manifest.dsh as { bundle?: unknown } | undefined;
        const bundlePath = bundlePathOf(dsh?.bundle);
        if (bundlePath === null) continue;

        const dir = manifestPath === 'package.json' ? '' : manifestPath.slice(0, -'/package.json'.length);
        const repoBundlePath = joinRepoPath(dir, bundlePath);
        if (verifyPatch) {
          // 声明了但文件不存在 → 剔除这个候选（不是故障）；其余故障仍按上游问题抛出。
          const probeRes = await getAllow404(
            `/repos/${candidate.owner}/${candidate.repo}/contents/${encodeURIComponent(repoBundlePath)}`,
          );
          if (probeRes === null) continue;
        }

        plugins.push({
          pluginPath: dir === '' ? '.' : dir,
          url: dir === '' ? candidate.htmlUrl : `${candidate.htmlUrl}/tree/${branch}/${dir}`,
          manifestPath,
          bundlePath: repoBundlePath,
          name: asTextOrNull(manifest.name as unknown, 200),
          description: asTextOrNull(manifest.description as unknown),
          version: asTextOrNull(manifest.version as unknown, 100),
        });
      }
      return plugins;
    },
  };
}
