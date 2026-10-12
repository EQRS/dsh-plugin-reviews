// 诊断：确认 Next dev 进程里 process.env 能读到我们设的变量。
// 通过一个临时路由不方便，改为直接检查 /api/session 的响应里能否反映。
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3100';

// 1) 检查 Node 子进程是否继承了变量（用于判断是 cmd 继承问题还是 Next 的问题）
const inherited = execFileSync('cmd.exe', ['/c', 'set "DSH_REVIEW_ALLOW_TEST_LOGIN=1" && node -e "console.log(process.env.DSH_REVIEW_ALLOW_TEST_LOGIN)"'], { encoding: 'utf8' });
console.log('cmd 继承测试:', inherited.trim());

// 2) 服务端行为
const code = execFileSync('curl.exe', ['-s', '-o', 'NUL', '-w', '%{http_code}', '-X', 'POST',
  '-H', 'content-type: application/json',
  '-d', '{"providerUserId":"gh-diag","providerUsername":"diag"}',
  `${BASE}/api/testing/session`], { encoding: 'utf8' });
console.log('/api/testing/session →', code);

// 3) 确认 /api/session 仍在工作（排除路由整体坏掉）
const session = execFileSync('curl.exe', ['-s', `${BASE}/api/session`], { encoding: 'utf8' });
console.log('/api/session →', session.slice(0, 160));
