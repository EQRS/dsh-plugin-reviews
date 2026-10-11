// 端到端 HTTP 验收：对真实运行中的 dev server 走一遍四条链路。
// 这是"能不能真的跑起来"的证据，不是单测。
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3100';
const jar = join(mkdtempSync(join(tmpdir(), 'jar-')), 'cookies.txt');

function curl(args) {
  const out = execFileSync('curl.exe', ['-s', '-b', jar, '-c', jar, ...args], { encoding: 'utf8' });
  return out;
}

function json(args) {
  const raw = curl(args);
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw.slice(0, 300) };
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// 1) 首页可访问
const home = curl(['-o', 'NUL', '-w', '%{http_code}', `${BASE}/`]);
check('首页 GET /', home === '200', `status=${home}`);

// 2) 未登录时 /api/session 报未认证（匿名可浏览）
const anon = json([`${BASE}/api/session`]);
check('匿名 /api/session', anon.ok === true && anon.data?.authenticated === false, JSON.stringify(anon.data));

// 3) 未登录写入被拒 —— 必须是 401，不是 500
const unauth = curl(['-X', 'POST', '-H', 'content-type: application/json',
  '-d', JSON.stringify({ pluginId: null, requestKey: 'k-anon' }),
  '-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/drafts`]);
check('未登录写草稿 → 401（不是 500）', unauth === '401', `status=${unauth}`);

// 4) 测试登录（开发环境通道）
const login = json(['-X', 'POST', '-H', 'content-type: application/json',
  '-d', JSON.stringify({ providerUserId: 'gh-live-1', providerUsername: 'liveuser', displayName: 'Live' }),
  `${BASE}/api/session`]);
check('测试登录 POST /api/session', login.ok === true && typeof login.data?.userId === 'string',
  `userId=${login.data?.userId ?? 'none'} note=${login.data?.note ?? ''}`);

// 5) 登录后 /api/session 显示已认证
const me = json([`${BASE}/api/session`]);
check('登录后 /api/session 已认证', me.data?.authenticated === true, JSON.stringify(me.data));

// 6) 插件收录：未接真实 GitHub 探针 → 必须明确 503 未配置（不得假装成功）
const submitPlugin = curl(['-X', 'POST', '-H', 'content-type: application/json',
  '-d', JSON.stringify({ url: 'https://github.com/acme/dsh-memory', requestKey: 'k-plugin-1' }),
  '-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/plugins`]);
check('收录插件（探针未配置）→ 503 且不假装成功', submitPlugin === '503', `status=${submitPlugin}`);

// 7) 公开列表可访问且为空
const list = json([`${BASE}/api/reviews`]);
check(
  '公开评测列表 GET /api/reviews（结构正确，不假设库为空）',
  list.ok === true && Array.isArray(list.data?.items) && typeof list.data?.total === 'number',
  `total=${list.data?.total}`,
);

// 8) 不存在的评测 → 404（不是 500）
const missing = curl(['-o', 'NUL', '-w', '%{http_code}',
  `${BASE}/api/reviews/01920000-0000-7000-8000-0000000000ff`]);
check('不存在的评测 → 404', missing === '404', `status=${missing}`);

// 9) 分页参数校验：非法 page_size 被拒
const badPage = curl(['-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/reviews?page_size=7`]);
check('非法 page_size → 400', badPage === '400', `status=${badPage}`);

// 10) 后台：非管理员被拒 403
const admin = curl(['-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/admin/submissions`]);
check('非管理员访问后台 → 403', admin === '403', `status=${admin}`);

// 11) 页面路由可达
for (const [path, name] of [['/plugins', '插件目录页'], ['/reviews', '评测列表页'], ['/me', '我的页'], ['/admin', '后台页']]) {
  const code = curl(['-o', 'NUL', '-w', '%{http_code}', `${BASE}${path}`]);
  check(`${name} ${path}`, code === '200', `status=${code}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== HTTP 验收：${results.length - failed.length}/${results.length} 通过 ====`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
