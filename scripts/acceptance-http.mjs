// 端到端 HTTP 验收：对真实运行中的 dev server 走一遍四条链路。
// 这是"能不能真的跑起来"的证据，不是单测。
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3100';
const jar = join(mkdtempSync(join(tmpdir(), 'jar-')), 'cookies.txt');

// 每次运行一个唯一后缀。**幂等键不能写死**：本脚本用固定的测试身份登录
// （gh-gate / gateuser），写死的 requestKey 第二次运行就会撞 request_key_reused(409) ——
// 那是幂等机制正确工作的结果，却会让"可重复运行"的验收误报失败（真踩过）。
const RUN = Date.now().toString(36);

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

// 2b) 旧登录旁路必须已移除：/api/session 不再接受 POST
const bypass = curl(['-X', 'POST', '-H', 'content-type: application/json',
  '-d', JSON.stringify({ providerUserId: 'gh-attacker', providerUsername: 'attacker' }),
  '-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/session`]);
check('旧登录旁路已移除（POST /api/session 不被接受）', bypass === '405' || bypass === '404', `status=${bypass}`);

// 2c) 测试登录通道的闸门：它的可用性必须**完全由开关决定**。
//     本脚本运行时 .env.local 已设 DSH_REVIEW_ALLOW_TEST_LOGIN=1（见 dev.cmd），
//     所以此处应为 200；若为 404 说明开关没生效。
const gateEnabled = anon.data?.testLoginEnabled === true;
const testGate = curl(['-X', 'POST', '-H', 'content-type: application/json',
  '-d', JSON.stringify({ providerUserId: 'gh-gate', providerUsername: 'gateuser' }),
  '-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/testing/session`]);
check('测试登录通道与开关状态一致', gateEnabled ? testGate === '200' : testGate === '404',
  `testLoginEnabled=${gateEnabled} status=${testGate}`);

// 3) 未登录写入被拒 —— 必须是 401，不是 500。
//    注意顺序：这一步必须发生在任何登录之前，否则测的是"已登录能不能写"。
//    因此这里用一个**独立的、没有任何 cookie 的**临时 jar，避免被共享 jar 污染。
const anonJar = join(mkdtempSync(join(tmpdir(), 'anon-')), 'none.txt');
const unauth = execFileSync(
  'curl.exe',
  ['-s', '-b', anonJar, '-c', anonJar, '-X', 'POST', '-H', 'content-type: application/json',
   '-d', JSON.stringify({ pluginId: null, requestKey: 'k-anon' }),
   '-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/drafts`],
  { encoding: 'utf8' },
);
check('未登录写草稿 → 401（不是 500）', unauth === '401', `status=${unauth}`);

// 3b) 匿名读私有附件状态也要被拒（不能只靠页面不显示）
const anonAttach = execFileSync(
  'curl.exe',
  ['-s', '-b', anonJar, '-c', anonJar, '-o', 'NUL', '-w', '%{http_code}',
   `${BASE}/api/attachments/01920000-0000-7000-8000-0000000000ff`],
  { encoding: 'utf8' },
);
check('匿名查私有附件 → 401/404（不是 200）', ['401', '404'].includes(anonAttach), `status=${anonAttach}`);

// 4) 未被选用的分支（真正的登录入口需要 GitHub 授权，浏览器里跑）：
//    这里只确认 start 路由在未配置凭据时**明确报未配置**，而不是伪装可用。
const startCode = curl(['-o', 'NUL', '-w', '%{http_code}', `${BASE}/api/auth/github/start`]);
check('GitHub 登录入口存在且如实反映配置状态', ['302', '503'].includes(startCode), `status=${startCode}`);

// 6) 插件收录：**绝不假装成功**。
//    探针未配置（离线）→ 503 `provider_not_configured`；
//    探针已配置（真实 api.github.com）→ "不存在的仓库"是**输入问题**：400 + 具体字段原因。
//    两者都是正确行为，共同底线是"没有真的收录成功"。
//    ⚠ 这里曾经写死 `=== '503'` —— 那是探针还是桩时的口径；接上真实探针之后，
//    同样的请求会（正确地）返回 400，脚本会**误报失败**。过时的是断言，不是实现。
const badRepoRaw = curl(['-X', 'POST', '-H', 'content-type: application/json',
  '-d', JSON.stringify({ url: 'https://github.com/acme/dsh-memory', requestKey: `k-plugin-${RUN}` }),
  '-w', '\n%{http_code}', `${BASE}/api/plugins`]);
const badRepoLines = badRepoRaw.split('\n');
const badRepoCode = badRepoLines[badRepoLines.length - 1].trim();
let badRepo = {};
try {
  badRepo = JSON.parse(badRepoLines.slice(0, -1).join('\n'));
} catch {
  badRepo = { __raw: badRepoLines.slice(0, -1).join('\n').slice(0, 200) };
}
const rejectedCatalogCodes = ['input_invalid', 'provider_not_configured', 'provider_unavailable'];
check(
  '收录插件：不存在的仓库被明确拒绝（400/503，不假装成功）',
  ['400', '503'].includes(badRepoCode) && badRepo.ok === false && rejectedCatalogCodes.includes(badRepo.error?.code),
  `status=${badRepoCode} code=${badRepo.error?.code} ${badRepo.error?.message ?? ''}`,
);

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
