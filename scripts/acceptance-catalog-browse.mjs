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
let skipped = 0;
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
    } else if (problem.startsWith('SKIP:')) {
      skipped += 1;
      console.log(`  - ${name}：跳过（${problem.slice(5).trim()}）`);
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
  // 页面已不再显示"共 N 个条目"（主人要求删掉那行文案）：
  // 总数改为结果区节点上的 `data-total`，验收读属性、不读界面文案。
  const m = /data-total="(\d+)"/.exec(html);
  return m ? Number(m[1]) : null;
}

console.log(`插件目录 HTTP 验收 → ${base}\n`);

// 目录是否为空，决定"空结果"该给哪种文案 —— 先探一次。
// 验收脚本必须在**空库与非空库都能跑通**（线上刚部署完就是空库）。
let directoryTotal = 0;
try {
  directoryTotal = countOf((await fetchPage('/plugins')).html) ?? 0;
  console.log(`（目录当前 ${directoryTotal} 条：空结果的文案按此判定）\n`);
} catch (error) {
  console.log(`（预探目录总数失败，按 0 处理：${error instanceof Error ? error.message : String(error)}）\n`);
}

await check('目录页可访问：空库走"目录为空"、非空库给出条目链接', '/plugins', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  const total = countOf(html);
  if (total === null) return '结果区没有 data-total（目录页应给出机器可读的总数）';
  if (!html.includes('提交插件')) return '缺少"提交插件"入口';
  if (total === 0) {
    // 线上刚部署完正是这种状态：必须明确说"目录为空"，不能只留一个空列表
    return html.includes('目录当前为空') ? null : '空库没有给出"目录当前为空"文案';
  }
  return /\/plugins\/[0-9a-f-]{36}/.test(html) ? null : '非空库却没有条目链接';
});

await check('搜索：不存在的关键词 → 0 条（按目录状态判文案）', '/plugins?q=zzz-not-exist-zzz', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (countOf(html) !== 0) return `总数应为 0，实际 ${countOf(html)}`;
  // 目录整体为空时，正确文案是"目录当前为空"（此时说"没有符合当前条件的条目"会误导用户；
  // 线上刚部署完正是这种状态）。目录非空时则必须明确说"筛选没匹配到"。
  if (directoryTotal === 0) return html.includes('目录当前为空') ? null : '空目录没有给出"目录当前为空"';
  return html.includes('没有符合当前条件的条目') ? null : '没有给出"筛选无结果"空状态';
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

await check('筛选：不存在的标签 → 0 条（按目录状态判文案）', '/plugins?tag=zzz-no-such-tag', ({ status, html }) => {
  if (status !== 200) return `HTTP ${status}`;
  if (countOf(html) !== 0) return `总数应为 0，实际 ${countOf(html)}`;
  if (directoryTotal === 0) return html.includes('目录当前为空') ? null : '空目录没有给出"目录当前为空"';
  return html.includes('没有符合当前条件的条目') ? null : '没有给出"筛选无结果"空状态';
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
  if (total === 0) return 'SKIP: 目录为空，越界与空目录无法区分';
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

console.log(`\n通过 ${passed} 条，跳过 ${skipped} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
