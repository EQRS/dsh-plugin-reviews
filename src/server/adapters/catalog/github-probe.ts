/**
 * 真实 GitHub 收录探针（工作包 GF，task-5）。
 *
 * 实现 `CatalogProbe`（`@/server/modules/catalog/types`）：用 api.github.com 完成
 * 「仓库可访问 + package.json 声明 dsh.bundle + 引用配置文件存在」三项收录检查的**取数**部分。
 * 判定逻辑（是否拒绝收录）在 catalog service，本文件只负责"如实取数"，不替业务做决定。
 *
 * ## 一、认证与"未配置"的语义（不要照抄 OAuth 适配器）
 *
 * 读**公开**仓库不需要令牌，所以"没配 GITHUB_TOKEN"**不是**未配置，不能因此拒绝收录
 * —— 那会把"匿名可读的公开仓库"误判成不可用。令牌只用于提高限流额度
 * （匿名 60 次/小时，带令牌 5000 次/小时）。
 *
 * 真正的"未配置"只有一种：显式要求离线（`DSH_REVIEW_CATALOG_OFFLINE=1`），
 * 用于 CI/离线环境，避免测试或流水线悄悄出网。详见 `docs/HANDOFF.md` 的"不装作可用"原则。
 *
 * ## 二、`dsh.bundle` 的形状（实测上游文档后定的，与直觉不同，必须说明）
 *
 * DSH 上游把 `dsh.bundle` 定义为**对象**，例如：
 *   { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
 * 其中 `patch` 可以是字符串，也可以是**有序字符串数组**
 * （见 https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish ：
 *  "`patch` 也接受一个有序的文件列表，例如 [\"./base.patch.yml\", \"./web.patch.yml\"]"）。
 *
 * 但冻结契约 `CatalogProbe.fetchPluginManifest` 的返回是 `{ bundlePath: string; bundleExists: boolean }`
 * ——**单个字符串**。契约不得修改，因此这里做一次**显式收敛**：
 * 取第一条 patch 路径作为 `bundlePath`，并把 `bundlePathCount` 放进……（不能加字段，形状已冻结）
 * 于是只用注释记录：数组形态下只核验**第一条**。这是已知的信息损失，
 * 对"引用配置文件是否存在"这一项检查是**保守**的（不会因为漏看后面几条而误放行，
 * 因为第一条必须存在才会判 true）。多 patch 的完整核验需要扩契约，留给后续。
 *
 * ## 三、`bundlePath` 的锚点（文档未明说，这里定并说明理由）
 *
 * 上游文档："每个文件中的相对插件路径相对于**该文件**解析"。
 * 且架构第 2841 行要求"**逐目录**校验 `dsh.bundle` 及引用配置存在"。
 * 结论：`dsh.bundle.patch` 里的相对路径**相对于声明它的 package.json 所在目录**，
 * 即相对 `pluginPath`，**不是**相对仓库根。
 * 例如 owner/repo 的 `sub/package.json` 声明 `./cordis.patch.yml` → 实际路径 `sub/cordis.patch.yml`。
 *
 * 处理规则（三条都实现，缺一不可）：
 *   - `./x`、`x`      → 相对 pluginPath 拼接；
 *   - `/x`            → 视为**仓库根**相对（显式根锚点，便于根级共享 patch）；
 *   - `../x`          → 先解析到 pluginPath 的父级（按段归并，且**不得越出仓库根**）。
 */

import { err } from '@/packages/common/errors';
import type { CatalogProbe } from '@/server/modules/catalog/types';

/**
 * 探针只需要"能按名字读到字符串"的环境变量视图。
 *
 * 刻意**不**声明为 `NodeJS.ProcessEnv`：该类型在本工程的 @types/node 下要求 `NODE_ENV` 必填，
 * 会让每个只关心 `GITHUB_TOKEN` 的调用点被迫补一个无关字段。真实 `process.env` 天然满足此类型。
 */
export type ProbeEnvView = Record<string, string | undefined>;

/** 探针依赖：`fetch` 与 `env` 都可注入，测试据此完全不出网。 */
export interface GithubCatalogProbeDeps {
  fetch?: typeof globalThis.fetch;
  env?: ProbeEnvView;
  /** 覆盖默认超时（毫秒），测试可用极小值验证超时路径。 */
  timeoutMs?: number;
}

/** 出网请求超时（架构第 103 节：外部资料请求 30 秒；任务要求 15 秒，取更保守的 15 秒）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

const API_BASE = 'https://api.github.com';

/** GitHub 建议的固定请求头；缺 user-agent 会被 api.github.com 拒绝。 */
function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-reviews',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** 供路由使用的失败形态：能区分"仓库不存在的 404"与"网络/限流故障"。 */
interface GithubErrorBody {
  message?: unknown;
}

/**
 * 把 base64 内容按 **UTF-8** 还原。
 *
 * ⚠️ 这是本文件最关键的一行：GitHub contents API 返回的 `content` 是 base64，
 * 且**包含换行**（每 60 字符一个 `\n`），必须先剥掉空白再解码；
 * 解码结果还要按 **UTF-8** 解释 —— 直接用 `atob()` 会得到 Latin-1 字节串，
 * 中文/emoji 会变成乱码（`JSON.parse` 之后字段值悄悄坏掉，或直接解析失败）。
 *
 * 实现走 Buffer：`Buffer.from(base64, 'base64')` 先得到**字节**，
 * `.toString('utf8')` 再按 UTF-8 解释，两步都不可省。
 */
export function decodeBase64Utf8(content: string): string {
  // GitHub 的 content 带换行，base64 解码器普遍容忍空白，但显式剥离更可控，
  // 也避免某些实现对 `\r\n` 的差异。
  const normalized = content.replace(/\s+/g, '');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * 展示字段的安全提取（迁移 0005）。
 *
 * 三条纪律，都是踩过坑的做法：
 *  1) **类型不符就返回 null**，不做 `String(v)` 强转 —— 强转会把 `{}` 变成 `"[object Object]"` 存进库；
 *  2) **超长截断**，避免上游把整篇 README 塞进 description 撑爆页面与库；
 *  3) **空串当没有**，不让空字符串冒充"有值"（页面要靠 null 显示"暂无"）。
 */
function asTextOrNull(v: unknown, maxLength = 2000): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** 只接受"非空字符串组成的数组"，其余（对象/数字/嵌套）一律按空处理，避免脏值进 JSON 列。 */
function asTopicList(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim().toLowerCase();
    if (t.length === 0 || t.length > 64) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** GitHub 的 ISO 时间串 → UTC 毫秒；解析不了返回 null（**不用 0 冒充**）。 */
function asUtcMsOrNull(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** package.json 的 author 归一：字符串直接用，对象取 `name`，其它形态按"无"处理。 */
function asAuthorOrNull(v: unknown): string | null {
  if (typeof v === 'string') return asTextOrNull(v, 200);
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return asTextOrNull((v as { name?: unknown }).name, 200);
  }
  return null;
}

/**
 * 从 `dsh.bundle` 声明里提取 patch 路径。
 *
 * 支持上游的两种形态：对象 `{ patch: string | string[] }` 与宽松的字符串直给。
 * 返回第一条路径（数组形态只取首条，见文件头注释）。
 */
export function extractBundlePatchPath(bundleDecl: unknown): string | null {
  if (typeof bundleDecl === 'string') {
    const trimmed = bundleDecl.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (bundleDecl === null || typeof bundleDecl !== 'object' || Array.isArray(bundleDecl)) return null;
  const patch = (bundleDecl as { patch?: unknown }).patch;
  if (typeof patch === 'string') {
    const trimmed = patch.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(patch)) {
    for (const item of patch) {
      if (typeof item === 'string' && item.trim().length > 0) return item.trim();
    }
  }
  return null;
}

/**
 * 把 `dsh.bundle.patch` 的相对路径解析成**仓库根相对**路径。
 *
 * 锚点规则见文件头第三节。所有分支都保证结果不含 `..`（不越出仓库根）。
 */
export function resolveBundleRepoPath(pluginPath: string, patchPath: string): string {
  const isRootRelative = patchPath.startsWith('/');
  const base = isRootRelative || pluginPath === '.' || pluginPath === '' ? [] : pluginPath.split('/').filter((s) => s.length > 0);
  const raw = isRootRelative ? patchPath.slice(1) : patchPath;

  const out: string[] = [...base];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // 归并到父级；已在根就忽略，绝不产生越出仓库根的 `..`。
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** 编码 GitHub contents 端点的路径：逐段 encodeURIComponent，保留 `/` 分隔。 */
function encodeContentPath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

interface ContentsResponse {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
  name?: unknown;
}

export function createGithubCatalogProbe(deps: GithubCatalogProbeDeps = {}): CatalogProbe {
  const doFetch: typeof globalThis.fetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const token = env.GITHUB_TOKEN?.trim() ?? '';
  const offline = env.DSH_REVIEW_CATALOG_OFFLINE === '1';

  function assertOnline(): void {
    if (offline) {
      throw err.notConfigured(
        '已设置 DSH_REVIEW_CATALOG_OFFLINE=1，收录探针被显式禁用，无法访问 GitHub。',
      );
    }
  }

  /** 带超时的 GET；返回原始 Response，由调用方按状态码分派。 */
  async function get(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: buildHeaders(token.length > 0 ? token : null),
        signal: controller.signal,
      });
    } catch (cause) {
      // 网络错误与超时都归为"外部依赖故障"，绝不伪装成"仓库不存在"。
      const reason = cause instanceof Error && cause.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : '网络请求失败';
      throw err.providerDown(`访问 GitHub 失败：${reason}。`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读取 GitHub 错误响应里的可展示说明（用于限流等故障）。 */
  async function readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as GithubErrorBody;
      if (typeof body.message === 'string' && body.message.trim().length > 0) return body.message.trim();
    } catch {
      /* 非 JSON 响应：用状态文本兜底 */
    }
    return `HTTP ${response.status}`;
  }

  /** 限流与服务器故障统一映射为 provider_unavailable。 */
  async function throwProviderDown(prefix: string, response: Response): Promise<never> {
    const message = await readErrorMessage(response);
    const retryAfter = response.headers.get('retry-after');
    const suffix = retryAfter ? `（建议 ${retryAfter} 秒后重试）` : '';
    throw err.providerDown(`${prefix}：${message}${suffix}`);
  }

  return {
    async fetchRepository(input) {
      assertOnline();
      const response = await get(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`);

      if (response.status === 404) {
        // 语义选择：404 表示"仓库不存在或私有不可见"。
        // 用 `err.input`（→400）而不是 provider_unavailable（→503）的理由：
        //   503 意味着"我们这边暂时坏了，稍后重试可能就好了"，会引导用户重试；
        //   但仓库名打错/私有是**用户输入的问题**，重试永远不会成功，
        //   且 400 带字段错误能让前端直接标在 URL 输入框上。
        // 安全上不给"私有仓库存在与否"的额外信息：统一按"无法访问"表述。
        throw err.input('该仓库不存在或不可公开访问，请检查链接。', [
          { path: 'url', message: '仓库不存在或不可公开访问。' },
        ]);
      }
      if (response.status === 403 || response.status === 429) {
        await throwProviderDown('GitHub 拒绝了本次请求（可能已触发限流）', response);
      }
      if (!response.ok) {
        await throwProviderDown(`GitHub 返回异常状态 ${response.status}`, response);
      }

      const body = (await response.json()) as {
        id?: unknown;
        full_name?: unknown;
        html_url?: unknown;
        archived?: unknown;
        // 以下都是**同一个响应体**里已有的字段（迁移 0005），不额外发请求
        description?: unknown;
        topics?: unknown;
        owner?: unknown;
        updated_at?: unknown;
      };

      // id 必须是数字（GitHub 稳定仓库 ID）；缺失说明响应形状异常，不能拿名字兜底当身份。
      if (typeof body.id !== 'number' || !Number.isFinite(body.id)) {
        throw err.providerDown('GitHub 仓库响应缺少稳定的数字 ID，无法确认仓库身份。');
      }
      if (typeof body.full_name !== 'string' || typeof body.html_url !== 'string') {
        throw err.providerDown('GitHub 仓库响应缺少必要字段，无法确认仓库身份。');
      }

      return {
        // 契约要求 string；GitHub 给的是数字。转成字符串保存（不参与数值运算）。
        githubRepositoryId: String(body.id),
        fullName: body.full_name,
        htmlUrl: body.html_url,
        // 字段缺失时保守视为"未归档"？不 —— 归档与否决定是否拒绝收录，
        // 缺失应保守视为**归档**（拒绝）还是**未归档**（放行）？
        // 上游一定返回该字段，缺失说明响应异常；这里严格取布尔，非 true 即 false，
        // 因为"缺字段"已在上面的必要字段校验中被拦住的只有 id/name/url。
        isArchived: body.archived === true,

        // 展示字段：能取就取，取不到留 null / 空数组（**不猜**）。这些不参与收录判定，
        // 所以缺了不影响"能不能收录"，只影响卡片显示得全不全。
        description: asTextOrNull(body.description, 2000),
        topics: asTopicList(body.topics),
        ownerLogin:
          body.owner !== null && typeof body.owner === 'object' && !Array.isArray(body.owner)
            ? asTextOrNull((body.owner as { login?: unknown }).login, 200)
            : null,
        ownerAvatarUrl:
          body.owner !== null && typeof body.owner === 'object' && !Array.isArray(body.owner)
            ? asTextOrNull((body.owner as { avatar_url?: unknown }).avatar_url, 1000)
            : null,
        repoUpdatedAt: asUtcMsOrNull(body.updated_at),
      };
    },

    async fetchPluginManifest(input) {
      assertOnline();
      const dir = input.pluginPath === '.' || input.pluginPath === '' ? '' : input.pluginPath;
      const manifestPath = dir.length > 0 ? `${dir}/package.json` : 'package.json';

      const response = await get(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeContentPath(manifestPath)}`,
      );

      // 404：该目录下没有 package.json → 未声明 dsh.bundle，返回 null（交给业务判"收录检查失败"）。
      if (response.status === 404) return null;
      if (response.status === 403 || response.status === 429) {
        await throwProviderDown('GitHub 拒绝了本次请求（可能已触发限流）', response);
      }
      if (!response.ok) {
        await throwProviderDown(`读取 package.json 失败（HTTP ${response.status}）`, response);
      }

      const listed = (await response.json()) as ContentsResponse | ContentsResponse[];

      // 若路径指向目录，GitHub 返回数组；此时不是 package.json 文件 → 视为未声明。
      if (Array.isArray(listed)) return null;
      if (typeof listed.content !== 'string') return null;
      // encoding 非 base64（例如 1MB 以上的文件 GitHub 会返回 encoding:"none" 且无 content）
      // → 无法读取声明，保守返回 null，不猜。
      if (listed.encoding !== undefined && listed.encoding !== 'base64') return null;

      let manifest: unknown;
      try {
        manifest = JSON.parse(decodeBase64Utf8(listed.content));
      } catch {
        // package.json 不是合法 JSON → 不是有效的插件清单，返回 null（不是服务器故障）。
        return null;
      }

      if (manifest === null || typeof manifest !== 'object') return null;

      // 清单里的展示字段（迁移 0005）：**同一个已经解析好的对象**，不额外发请求。
      const manifestFields = manifest as {
        name?: unknown;
        description?: unknown;
        author?: unknown;
        version?: unknown;
      };
      const display = {
        name: asTextOrNull(manifestFields.name, 200),
        description: asTextOrNull(manifestFields.description, 2000),
        author: asAuthorOrNull(manifestFields.author),
        version: asTextOrNull(manifestFields.version, 100),
      };

      const dsh = (manifest as { dsh?: unknown }).dsh;
      if (dsh === null || typeof dsh !== 'object') return null;
      const bundleDecl = (dsh as { bundle?: unknown }).bundle;
      if (bundleDecl === undefined || bundleDecl === null) return null;

      const patchPath = extractBundlePatchPath(bundleDecl);
      // 声明了 dsh.bundle 但没有可用的 patch 路径 → 声明为空，交由业务报错（返回非 null，
      // 让 service 的"dsh.bundle 声明为空"分支命中，而不是笼统地说"没声明"）。
      if (patchPath === null) return { bundlePath: '', bundleExists: false, ...display };

      const repoPath = resolveBundleRepoPath(dir.length > 0 ? dir : '.', patchPath);
      if (repoPath.length === 0) return { bundlePath: '', bundleExists: false, ...display };

      const bundleResponse = await get(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeContentPath(repoPath)}`,
      );

      if (bundleResponse.status === 404) {
        // 明确"声明了但文件不存在"：返回路径 + false，让 business 层给出可展示的原因。
        return { bundlePath: repoPath, bundleExists: false, ...display };
      }
      if (bundleResponse.status === 403 || bundleResponse.status === 429) {
        await throwProviderDown('GitHub 拒绝了本次请求（可能已触发限流）', bundleResponse);
      }
      if (!bundleResponse.ok) {
        await throwProviderDown(`校验 dsh.bundle 引用的文件失败（HTTP ${bundleResponse.status}）`, bundleResponse);
      }

      // 路径指向目录（数组响应）= 不是配置文件 → 视为不存在（patch 必须是文件）。
      const bundleBody = (await bundleResponse.json()) as ContentsResponse | ContentsResponse[];
      if (Array.isArray(bundleBody)) return { bundlePath: repoPath, bundleExists: false, ...display };

      return { bundlePath: repoPath, bundleExists: true, ...display };
    },
  };
}

/** 当前环境是否要求离线（供路由与测试查询，避免各自读 env）。 */
export function catalogProbeIsOffline(env: ProbeEnvView = process.env): boolean {
  return env.DSH_REVIEW_CATALOG_OFFLINE === '1';
}
