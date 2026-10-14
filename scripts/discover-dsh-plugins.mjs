#!/usr/bin/env node
/**
 * 发现真实的 DSH 插件（一次性/运维工具，**不是**那个还没做的"每日自动发现"）。
 *
 * 做三件事：
 *   1. 用 GitHub 搜索找候选仓库（默认查 `topic:dsh-plugin`、`topic:dsh`、`dsh.bundle` 关键词）；
 *   2. 对每个候选**逐个核对收录条件**（仓库可访问 + 某个 package.json 声明了 dsh.bundle +
 *      引用的 patch 文件存在）；
 *   3. 打印可直接用于收录的 URL 列表（`--json` 给脚本消费）。
 *
 * 纪律：
 *   * **不猜**：只认"真的声明了 dsh.bundle 且文件存在"的，其余如实标原因；
 *   * 发现与收录**分开**：本脚本只读 GitHub，不写本站数据库（写入由 seed/收录路径做）；
 *   * 出网失败/限流如实报告，不当成"没有插件"。
 *
 * 用法：
 *   npx tsx scripts/discover-dsh-plugins.mjs                 # 人读
 *   npx tsx scripts/discover-dsh-plugins.mjs --json          # 机器读（给 seed 脚本用）
 *   npx tsx scripts/discover-dsh-plugins.mjs --query "topic:foo"
 *
 * 需要 token：环境变量 GITHUB_TOKEN（或 .env.local 里的那行）。没有 token 也能跑，
 * 但搜索限额低得多（每小时 10 次），且会明确告警。
 */

import { readFileSync, existsSync } from 'node:fs';

function loadToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim().length > 0) return process.env.GITHUB_TOKEN.trim();
  if (!existsSync('.env.local')) return null;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*GITHUB_TOKEN\s*=\s*(.+)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  return null;
}

const TOKEN = loadToken();
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const qIdx = args.indexOf('--query');
const queries = qIdx >= 0 ? [args[qIdx + 1]] : ['topic:dsh-plugin', 'topic:dsh', 'dsh.bundle in:name,description,readme'];

const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-plugin-reviews-discovery',
  'x-github-api-version': '2022-11-28',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: HEADERS });
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub 限流或拒绝（HTTP ${res.status}）；有 token 的话额度高得多`);
  }
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

function decodeBase64Utf8(content) {
  return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

/** 从 dsh.bundle 声明里取 patch 路径（对象取 patch，字符串直接用）。 */
function patchPathOf(bundleDecl) {
  if (typeof bundleDecl === 'string') return bundleDecl.trim() || null;
  if (bundleDecl && typeof bundleDecl === 'object' && !Array.isArray(bundleDecl)) {
    const p = bundleDecl.patch;
    if (typeof p === 'string') return p.trim() || null;
    if (Array.isArray(p) && typeof p[0] === 'string') return p[0].trim() || null;
  }
  return null;
}

/** 在一个仓库里找出所有"声明了 dsh.bundle"的 package.json 路径。 */
async function findPluginPaths(owner, repo, defaultBranch) {
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
  if (!tree.ok) return { paths: [], note: `读仓库树失败 HTTP ${tree.status}` };

  const manifestPaths = (tree.body.tree ?? [])
    .filter((n) => n.type === 'blob' && typeof n.path === 'string' && n.path.endsWith('package.json'))
    // 忽略 node_modules / 示例目录里的 package.json（那些不是可收录的插件本体）
    .filter((n) => !/(^|\/)node_modules\//.test(n.path))
    .map((n) => n.path);
  if (manifestPaths.length > 0 && manifestPaths.length > 200) {
    return { paths: [], note: `package.json 太多（${manifestPaths.length} 个），跳过以免打爆额度` };
  }

  const found = [];
  for (const p of manifestPaths) {
    const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}`);
    if (!res.ok || Array.isArray(res.body) || typeof res.body.content !== 'string') continue;
    let manifest;
    try {
      manifest = JSON.parse(decodeBase64Utf8(res.body.content));
    } catch {
      continue;
    }
    const bundle = manifest?.dsh?.bundle;
    const patchPath = patchPathOf(bundle);
    if (!patchPath) continue;
    const dir = p === 'package.json' ? '' : p.slice(0, -'/package.json'.length);
    const repoPatch = dir === '' ? patchPath.replace(/^\.\//, '') : `${dir}/${patchPath.replace(/^\.\//, '')}`;
    const patchRes = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(repoPatch)}`);
    found.push({
      manifestPath: p,
      pluginPath: dir === '' ? '.' : dir,
      patchPath: repoPatch,
      patchExists: patchRes.ok && !Array.isArray(patchRes.body),
      name: typeof manifest.name === 'string' ? manifest.name : null,
      description: typeof manifest.description === 'string' ? manifest.description : null,
      version: typeof manifest.version === 'string' ? manifest.version : null,
    });
  }
  return { paths: found, note: null };
}

async function main() {
  if (!TOKEN) {
    console.error('⚠️ 没有 GITHUB_TOKEN：搜索额度只有每小时 10 次，结果可能很少。');
  }

  const seen = new Set();
  const candidates = [];

  for (const q of queries) {
    const res = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`);
    if (!res.ok) {
      console.error(`  ! 搜索「${q}」失败：HTTP ${res.status}`);
      continue;
    }
    console.error(`  搜索「${q}」→ ${res.body.total_count} 个结果，检查前 ${res.body.items.length} 个`);
    for (const item of res.body.items) {
      if (item.archived) continue;
      if (seen.has(item.full_name)) continue;
      seen.add(item.full_name);

      const scan = await findPluginPaths(item.owner.login, item.name, item.default_branch);
      for (const hit of scan.paths) {
        candidates.push({
          fullName: item.full_name,
          htmlUrl: item.html_url,
          stars: item.stargazers_count,
          repoUpdatedAt: item.updated_at,
          repoDescription: item.description,
          topics: item.topics ?? [],
          url:
            hit.pluginPath === '.'
              ? item.html_url
              : `${item.html_url}/tree/${item.default_branch}/${hit.pluginPath}`,
          ...hit,
        });
      }
    }
  }

  // 只留"patch 文件真的存在"的（收录条件第三条）
  const usable = candidates.filter((c) => c.patchExists);
  const rejected = candidates.filter((c) => !c.patchExists);

  if (asJson) {
    console.log(JSON.stringify({ usable, rejected }, null, 2));
  } else {
    console.log(`\n=== 可收录候选（${usable.length} 条）===`);
    for (const c of usable) {
      console.log(`  ${c.fullName}${c.pluginPath === '.' ? '' : ` / ${c.pluginPath}`}  ★${c.stars}`);
      console.log(`     ${c.url}`);
      console.log(`     名称=${c.name ?? '(无)'} 版本=${c.version ?? '(无)'} topics=${c.topics.join(',') || '(无)'}`);
      console.log(`     简介=${(c.description ?? c.repoDescription ?? '(无)').slice(0, 70)}`);
    }
    if (rejected.length > 0) {
      console.log(`\n=== 声明了但 patch 文件不存在（${rejected.length} 条，**不可收录**）===`);
      for (const c of rejected) console.log(`  ${c.fullName} / ${c.pluginPath} → 缺 ${c.patchPath}`);
    }
    console.log(`\n统计：扫过仓库 ${seen.size} 个，找到声明 ${candidates.length} 处，可收录 ${usable.length} 处。`);
  }
}

await main();
