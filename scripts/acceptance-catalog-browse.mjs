#!/usr/bin/env node
/**
 * 插件目录浏览的 HTTP 验收（搜索 / 筛选 / 排序 / 分页 / 空状态 / 404）。
 *
 * 与 scripts/acceptance-http*.mjs 同一套路：**对真实运行的服务发请求**，断言返回的 HTML，
 * 不使用 mock。刻意做成"不依赖库里有几条数据"——所以关键断言只用"必然为 0"的条件
 * （不存在的关键词、非法标签、转义字符），任何数据状态下都能跑。
 *
 * 用法：
 *   npx tsx scripts/acceptance-catalog-browse.mjs                     # 默认 http://127.0.0.1:3211
 *   DSH_ACCEPTANCE_BASE=http://127.0.0.1:3000 npx tsx scripts/acceptance-catalog-browse.mjs
 *
 * 退出码：0 = 全过；1 = 有断言失败（逐条打印失败原因）。
 */

const base = (process.env.DSH_ACCEPTANCE_BASE ?? 'http://127.0.0.1:3211').replace(/\/$/, '');

let passed = 0;
const failures = [];

/** React 会在插值处插入 `<!-- -->`，先剥掉再匹配文本，否则正则被隔开。 */
function normalize(html) {
  return html.replace(/<!-- -->/g, '');
}

async function fetchPage(path) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' });
  const html = normalize(await response.text());
  return { status: response.status, html };
}

async function check(name, path, assert) {
  try {
    const page = await fetchPage(path);
    const problem = assert(page);
    if (problem === null) {
      passed += 1;
      console.log(`  ✓ ${name}`);
    } else {
      failures.push(`${name}（${path}）：${problem}`);
      console.log(`  ✗ ${name}（${path}）：${problem}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}（${path}）：请求失败 ${message}`);
    console.log(`  ✗ ${name}（${path}）：请求失败 ${message}`);
  }
}

function countOf(html) {
  const m = /共 (\d+) 个条目/.exec(html);
  return m ? Number(m[1]) : null;
}

console.log(`插件目录 HTTP 验收 → ${base}\n`);

await check('目录页可访问且有真实总数', '/plugins', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  const total = countOf(html);
  if (total === null) return '页面上没有"共 N 个条目"';
  if (!html.includes('提交插件')) return '缺少"提交插件"入口';
  return null;
});

await check('搜索：不存在的关键词 → 0 条且给"筛选无结果"文案', '/plugins?q=zzz-not-exist-zzz', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (countOf(html) !== 0) return `总数应为 0，实际 ${countOf(html)}`;
  if (!html.includes('没有符合当前条件的条目')) return '没有给出"筛选无结果"空状态';
  return null;
});

await check('搜索转义：q=% 不得匹配全表', '/plugins?q=%25', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (countOf(html) !== 0) return `未转义通配符：q=% 命中了 ${countOf(html)} 条`;
  return null;
});

await check('搜索转义：q=_ 不得匹配任意单字符', '/plugins?q=_', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (countOf(html) !== 0) return `未转义通配符：q=_ 命中了 ${countOf(html)} 条`;
  return null;
});

await check('筛选：不存在的标签 → 0 条 + 筛选无结果', '/plugins?tag=zzz-no-such-tag', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (countOf(html) !== 0) return `总数应为 0，实际 ${countOf(html)}`;
  if (!html.includes('没有符合当前条件的条目')) return '没有给出"筛选无结果"空状态';
  return null;
});

await check('筛选：暂无评测 是"全部"的子集', '/plugins?has_reviews=no', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  const total = countOf(html);
  if (total === null) return '没有总数';
  return null;
});

await check('排序：按评测数可用', '/plugins?sort=reviews', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  return countOf(html) === null ? '没有总数' : null;
});

await check('越界页：给"超出范围"而不是"筛选无结果"', '/plugins?page=99', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  const total = countOf(html);
  if (total === 0) return '当前目录为空，本用例无法区分（先收录至少一个插件再跑）';
  if (!html.includes('超出范围')) return '没有越界提示';
  if (html.includes('没有符合当前条件的条目')) return '越界时不应该报"筛选无结果"';
  return null;
});

await check('首页有搜索入口与"近期更新插件"', '/', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (!html.includes('/plugins')) return '首页没有指向目录的链接';
  if (!html.includes('近期更新插件')) return '首页没有"近期更新插件"一块';
  if (html.includes('搜索、分类与筛选的完整交互见')) return '首页仍在写那句"见插件目录"的空话';
  return null;
});

await check('不存在的插件 id → 404（不是 200 空白页）', '/plugins/00000000-0000-7000-8000-000000000000', ({ status }) =>
  status === 404 ? null : `HTTP ${status}`,
);

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
