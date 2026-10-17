/**
 * 提交链接解析（工作包 GI，契约 已删除的设计稿《模块签名契约》 第 2 节）。
 *
 * 支持形态：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<branch>
 *   https://github.com/owner/repo/tree/<branch>/<subpath>
 *   https://github.com/owner/repo/tree/<40位commit>/<subpath>
 *
 * 归一化规则：
 *  - `plugin_path` 根目录统一表示为 `'.'`（数据库 UNIQUE 按 BINARY 比较，
 *    所以绝不能同时存在 '.' 与 ''、'./' 这类"看起来一样"的写法）；
 *  - 保留仓库内路径的**实际大小写**（GitHub 路径大小写敏感）；
 *  - 分支名可含 `/`（如 `feature/x`），因此不假设分支只有一段 —— 见下方切分策略；
 *  - 只接受 github.com 的 https/http 链接；其他站点明确报错，不猜。
 */

export interface ParsedSubmissionUrl {
  owner: string;
  repo: string;
  pluginPath: string;
}

export interface ParseError {
  error: string;
}

/** 根目录的规范表示。 */
export const ROOT_PLUGIN_PATH = '.';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;

/** 去掉结尾的 `.git` 与斜杠，便于接受"复制粘贴自地址栏"的链接。 */
function normalizeRepoName(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/** 把剩余路径段拼成规范化子路径；空 → '.'。 */
function normalizeSubPath(segments: string[]): string {
  const cleaned = segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.');
  return cleaned.length === 0 ? ROOT_PLUGIN_PATH : cleaned.join('/');
}

/**
 * 解析 tree 形态中「分支名」与「子路径」的边界。
 *
 * 难点：`/tree/<branch>/<subpath>` 里分支自身可含 `/`，无法从字符串本身唯一确定边界。
 * 采取的策略（必须在文档与测试里说清楚，而不是假装无歧义）：
 *  - 若第一段是 40 位 commit SHA：整段是 ref，其余全部是子路径（无歧义）；
 *  - 否则：把**最后一段之后的剩余**视为子路径，第一段视为分支。
 *    例如 `/tree/main/src/plugins/foo` → branch='main', pluginPath='src/plugins/foo'；
 *    `/tree/feature/x` → branch='feature', pluginPath='x'（歧义形态，按此约定处理）。
 *  - 调用方若需要精确边界，应提交带 commit SHA 的永久链接。
 */
function splitRefAndPath(rest: string[]): { ref: string; pluginPath: string } {
  if (rest.length === 0) {
    return { ref: '', pluginPath: ROOT_PLUGIN_PATH };
  }
  const first = rest[0] as string;
  if (FULL_COMMIT_RE.test(first)) {
    return { ref: first, pluginPath: normalizeSubPath(rest.slice(1)) };
  }
  return { ref: first, pluginPath: normalizeSubPath(rest.slice(1)) };
}

export function parseSubmissionUrl(rawUrl: string): ParsedSubmissionUrl | ParseError {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { error: '请填写 GitHub 仓库或子目录链接。' };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: '链接格式无效，请粘贴完整的 https://github.com/owner/repo 链接。' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: '只支持 http/https 链接。' };
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return { error: '目前只支持 github.com 上的仓库链接。' };
  }

  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length < 2) {
    return { error: '链接缺少仓库名，应为 https://github.com/<owner>/<repo>。' };
  }

  const owner = segments[0] as string;
  const repo = normalizeRepoName(segments[1] as string);

  if (!OWNER_RE.test(owner)) {
    return { error: `仓库所有者名称无效：${owner}` };
  }
  if (!REPO_RE.test(repo) || repo.length === 0) {
    return { error: `仓库名称无效：${segments[1]}` };
  }

  const rest = segments.slice(2);
  if (rest.length === 0) {
    return { owner, repo, pluginPath: ROOT_PLUGIN_PATH };
  }

  const kind = (rest[0] as string).toLowerCase();
  if (kind === 'tree' || kind === 'blob') {
    const { pluginPath } = splitRefAndPath(rest.slice(1));
    // blob 指向单个文件，不能当作插件目录。
    if (kind === 'blob') {
      return { error: '该链接指向单个文件，请改为插件所在的目录链接。' };
    }
    return { owner, repo, pluginPath };
  }

  if (kind === 'releases' || kind === 'issues' || kind === 'pull' || kind === 'actions') {
    return { error: '该链接不是仓库或子目录链接，请提交仓库首页或 tree/<分支>/<子目录> 链接。' };
  }

  // 其它形态（例如 /owner/repo/commit/<sha>）不猜测语义，明确拒绝。
  return { error: `无法识别的链接形态：/${segments.join('/')}。请提交仓库首页或 tree/<分支>/<子目录> 链接。` };
}
