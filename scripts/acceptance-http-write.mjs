// HTTP 写入链路验收：草稿 → 提交 → (管理员)通过 → 发布 → 公开详情 → 评论。
// 直接对运行中的 dev server 发请求，并用真实数据库行核对结果。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const BASE = 'http://127.0.0.1:3100';
const dir = mkdtempSync(join(tmpdir(), 'jar-w-'));
const jar = join(dir, 'cookies.txt');

// 每次运行使用唯一身份与请求键：否则会复用上一轮已撤回的评测，让结果不可信。
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const k = (name) => `${name}-${RUN}`;

function post(path, body) {
  return call('POST', path, body);
}

function call(method, path, body) {
  const f = join(dir, `b-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(body));
  const raw = execFileSync(
    'curl.exe',
    ['-s', '-b', jar, '-c', jar, '-X', method, '-H', 'content-type: application/json', '--data-binary', `@${f}`, `${BASE}${path}`],
    { encoding: 'utf8' },
  );
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw.slice(0, 400) };
  }
}

function get(path) {
  const raw = execFileSync('curl.exe', ['-s', '-b', jar, '-c', jar, `${BASE}${path}`], { encoding: 'utf8' });
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw.slice(0, 400) };
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// 登录作者。
// 注意：authorId 必须**在登录这一刻**从响应里取，不能晚点再用共享 jar 去查 ——
// 共享 jar 后面会被用来登录读者/管理员，那时再查到的就是别人的 ID。
const authorLogin = post('/api/testing/session', {
  providerUserId: `gh-w-author-${RUN}`,
  providerUsername: `wauthor-${RUN}`,
});
check('作者登录', authorLogin.ok === true && typeof authorLogin.data?.userId === 'string', authorLogin.data?.userId);
const authorId = authorLogin.data.userId;
// 作者自己单独的 jar：撤回等"作者本人操作"必须用作者会话，不能借用共享 jar。
const authorJar = join(dir, 'author-cookies.txt');
writeFileSync(join(dir, 'author.json'), JSON.stringify({ providerUserId: `gh-w-author-${RUN}`, providerUsername: `wauthor-${RUN}` }));
execFileSync('curl.exe', ['-s', '-b', authorJar, '-c', authorJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${join(dir, 'author.json')}`,
  `${BASE}/api/testing/session`], { encoding: 'utf8' });

// 直接在库里放一个插件（本切片未接真实 GitHub 探针，收录检查无法真跑；
// 这条明确标注为"绕过了收录检查"，不是假装收录成功）
const db = new Database(join(process.cwd(), '.data', 'app.sqlite'));
db.pragma('foreign_keys = ON');
const repoId = '01920000-0000-7000-8000-0000000000a1';
const pluginId = '01920000-0000-7000-8000-0000000000a2';
const now = Date.now();
db.prepare(
  `INSERT OR IGNORE INTO repositories (id, github_repository_id, full_name, html_url, availability_state, created_at, updated_at)
   VALUES (?, 'gh-seed-1', 'acme/dsh-memory', 'https://github.com/acme/dsh-memory', 'available', ?, ?)`,
).run(repoId, now, now);
db.prepare(
  `INSERT OR IGNORE INTO plugins (id, repository_id, plugin_path, created_at, updated_at) VALUES (?, ?, '.', ?, ?)`,
).run(pluginId, repoId, now, now);
console.log(`(seed) 直接插入插件 ${pluginId} —— 绕过了收录检查（本切片未接真实探针）`);

// 1) 建草稿
const draft = post('/api/drafts', { pluginId, requestKey: k('w-draft') });
check('POST /api/drafts 建草稿', draft.ok === true && !!draft.data?.draftId, draft.data?.draftId ?? JSON.stringify(draft));

// 2) 保存（PUT：方法语义唯一，避免被当成新建）
const save = call('PUT', '/api/drafts', {
  draftId: draft.data.draftId,
  expectedVersion: 0,
  requestKey: k('w-save'),
  title: 'HTTP 链路验收：一篇真实评测',
  pluginId,
  pluginVersion: { kind: 'known', value: '1.2.0' },
  dshVersion: { kind: 'known', value: '0.3.1' },
  body: [{ key: 's1', markdown: '## 用它做什么\n\n通过 HTTP 验收链路写入。' }],
});
check('保存草稿 save_version=1', save.ok === true && save.data?.saveVersion === 1, JSON.stringify(save.data ?? save));

// 3) 提交（PATCH）
const subParsed = call('PATCH', '/api/drafts', {
  draftId: draft.data.draftId,
  expectedSaveVersion: 1,
  requestKey: k('w-submit'),
  title: 'HTTP 链路验收：一篇真实评测',
  bodyMarkdown: '## 用它做什么\n\n通过 HTTP 验收链路写入。',
  pluginVersion: { kind: 'known', value: '1.2.0' },
  dshVersion: { kind: 'known', value: '0.3.1' },
});
check('提交生成快照与提交记录', subParsed.ok === true && !!subParsed.data?.submissionId, JSON.stringify(subParsed.data ?? subParsed));

// 4) 直接发布应被拒（未 approved）
const reviewId = subParsed.data?.reviewId;
const beforePublish = get(`/api/reviews/${reviewId}`);
check('未发布前公开详情 → 404（不是 500）', beforePublish.ok === false && beforePublish.error?.code === 'target_unavailable',
  JSON.stringify(beforePublish.error?.code ?? beforePublish));

// 5) 造管理员，并**以管理员身份**登录后做出人工决定。
// 注意两点：
//  a) 权限每次从库里读，所以必须先真的登录成管理员，不能只塞一行数据；
//  b) 提交初始为 pending，未配置内容筛查时必须先转 manual_review（绝不自动放行），
//     转阶段会把 state_version 递增到 1，因此人工决定要带 expectedStateVersion=1。
const adminId = '01920000-0000-7000-8000-0000000000a9';
db.prepare(
  `INSERT OR IGNORE INTO users (id, nickname, role, account_status, created_at, updated_at)
   VALUES (?, '验收管理员', 'admin', 'active', ?, ?)`,
).run(adminId, now, now);

// 把管理员的 GitHub 身份直接绑到上面这行（模拟"部署时指定的首个管理员已登录过一次"）
const adminJar = join(dir, 'admin-cookies.txt');
const adminIdentity = {
  providerUserId: `gh-w-admin-${RUN}`,
  providerUsername: `wadmin-${RUN}`,
};
// 先正常登录建出用户，再把该用户提权并绑定到固定 adminId（避免改动 identity 模块）
writeFileSync(join(dir, 'a.json'), JSON.stringify(adminIdentity));
const adminLoginRaw = execFileSync('curl.exe', ['-s', '-b', adminJar, '-c', adminJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${join(dir, 'a.json')}`, `${BASE}/api/testing/session`],
  { encoding: 'utf8' });
const adminLogin = JSON.parse(adminLoginRaw);
check('管理员账户登录', adminLogin.ok === true, adminLogin.data?.userId);
// 提权：把刚登录的用户改成 admin（模拟后台授予管理员）
db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(adminLogin.data.userId);

const { createModerationService } = await import('../src/server/modules/moderation/index.ts');
const moderation = createModerationService(db);

// 读提交当前的真实阶段与版本（脚本可能被重复执行，不能假设从 0 开始）。
function submissionState(id) {
  return db.prepare('SELECT processing_state, state_version FROM content_submissions WHERE id = ?').get(id);
}
let st = submissionState(subParsed.data.submissionId);
if (st.processing_state === 'pending') {
  await moderation.transition(subParsed.data.submissionId, {
    expectedStateVersion: st.state_version,
    to: 'manual_review',
    reason: '内容筛查服务未配置，转人工处理。',
  });
  st = submissionState(subParsed.data.submissionId);
}
check('提交进入待人工处理', st.processing_state === 'manual_review', JSON.stringify(st));
const stateVersionBeforeDecision = st.state_version;

// 用**管理员 Cookie** 调人工决定
const modBodyFile = join(dir, 'mod.json');
writeFileSync(modBodyFile, JSON.stringify({
  submissionId: subParsed.data.submissionId,
  decision: 'approve',
  reason: '环境、过程、结果与依据齐全（HTTP 验收）。',
  expectedStateVersion: stateVersionBeforeDecision,
  requestKey: `w-approve-${Date.now()}`,
}));
const modRaw = execFileSync('curl.exe', ['-s', '-b', adminJar, '-c', adminJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${modBodyFile}`, `${BASE}/api/admin/submissions/${subParsed.data.submissionId}/decisions`],
  { encoding: 'utf8' });
let mod;
try { mod = JSON.parse(modRaw); } catch { mod = { __raw: modRaw.slice(0, 300) }; }
check('管理员人工通过', mod.ok === true && mod.data?.state === 'approved', JSON.stringify(mod.data ?? mod));

// 6) 发布（workflow 直接调用，本切片未做后台发布入口）
const { publishReview } = await import('../src/server/workflows/publish-review.ts');
const outcome = publishReview(subParsed.data.submissionId, db);
// 重复执行时若已发布，publishReview 返回 already_published —— 同样算达成目标。
check('发布成功', outcome.published === true || outcome.reason === 'already_published', JSON.stringify(outcome));

// 7) 公开详情真能读到
const detail = get(`/api/reviews/${reviewId}`);
check('公开详情可读且含正文', detail.ok === true && String(detail.data?.bodyMarkdown ?? '').includes('HTTP 验收链路'),
  JSON.stringify(detail.data?.title ?? detail.error?.code));
check('详情显示被测版本', detail.data?.pluginVersion?.value === '1.2.0', JSON.stringify(detail.data?.pluginVersion));

// 8) 列表包含它
const list = get('/api/reviews');
check('公开列表包含该评测', list.ok === true && list.data?.total >= 1, `total=${list.data?.total}`);

// 9) 评论（换读者登录）
const jar2 = join(dir, 'cookies2.txt');
writeFileSync(join(dir, 'r.json'), JSON.stringify({ providerUserId: `gh-w-reader-${RUN}`, providerUsername: `wreader-${RUN}` }));
execFileSync('curl.exe', ['-s', '-b', jar2, '-c', jar2, '-X', 'POST', '-H', 'content-type: application/json',
  '--data-binary', `@${join(dir, 'r.json')}`, `${BASE}/api/testing/session`], { encoding: 'utf8' });

writeFileSync(join(dir, 'c.json'), JSON.stringify({ body: 'HTTP 验收：请问支持 0.3 吗？', requestKey: k('w-c') }));
const commentRaw = execFileSync('curl.exe', ['-s', '-b', jar2, '-c', jar2, '-X', 'POST', '-H', 'content-type: application/json',
  '--data-binary', `@${join(dir, 'c.json')}`, `${BASE}/api/content/${reviewId}/comments`], { encoding: 'utf8' });
let comment;
try { comment = JSON.parse(commentRaw); } catch { comment = { __raw: commentRaw.slice(0, 300) }; }
check('读者提交评论', comment.ok === true && !!comment.data?.commentId, JSON.stringify(comment.data ?? comment));

// 10) 评论创建后**不会**自动公开：本切片没有评论发布处理器（worker handlers 为空），
//     所以它停在 pending、published_revision_id 为空，公开列表里看不到 —— 这是"未实现"，
//     不是缺陷；但它**必须**是不可见的（架构第 78.2 节），否则就是泄露。
const comments = get(`/api/content/${reviewId}/comments`);
const leaked = (comments.data?.items ?? []).some((c) => String(c.body ?? '').includes('增量索引'));
check(
  '未发布的评论不出现在公开列表（不可泄露）',
  comments.ok === true && comments.data?.total === 0 && leaked === false,
  `total=${comments.data?.total}`,
);
const pendingRow = db
  .prepare(
    `SELECT s.processing_state, c.published_revision_id
       FROM content_submissions s
       JOIN comment_revisions cr ON cr.id = s.comment_revision_id
       JOIN comments c ON c.id = cr.comment_id
      WHERE c.id = ?`,
  )
  .get(comment.data.commentId);
check(
  '评论如实停在待处理（不伪装已发布）',
  pendingRow?.processing_state === 'pending' && pendingRow?.published_revision_id === null,
  JSON.stringify(pendingRow),
);

// 11) 作者撤回（走真实 HTTP，且用**作者自己的会话**）
const { resolveVisibilityInTx } = await import('../src/server/modules/content/index.ts');
const vis = resolveVisibilityInTx(db, reviewId);
if (!vis.withdrawn) {
  const wf = join(dir, 'w.json');
  writeFileSync(wf, JSON.stringify({
    expectedControlVersion: vis.controlVersion,
    reason: 'HTTP 验收撤回',
    requestKey: `w-withdraw-${Date.now()}`,
  }));
  const withdrawRes = JSON.parse(
    execFileSync('curl.exe', ['-s', '-b', authorJar, '-c', authorJar, '-X', 'POST',
      '-H', 'content-type: application/json', '--data-binary', `@${wf}`,
      `${BASE}/api/reviews/${reviewId}/withdraw`], { encoding: 'utf8' }),
  );
  check('作者本人可撤回', withdrawRes.ok === true, JSON.stringify(withdrawRes.data ?? withdrawRes.error?.code));
}

// 11b) 读者（非作者）撤回同一篇必须被拒 —— 排除"谁都能撤回"
const readerWithdraw = JSON.parse(
  execFileSync('curl.exe', ['-s', '-b', jar2, '-c', jar2, '-X', 'POST',
    '-H', 'content-type: application/json',
    '--data-binary', `@${(() => { const f = join(dir, 'w2.json'); writeFileSync(f, JSON.stringify({ expectedControlVersion: 0, reason: 'x', requestKey: `w-withdraw-reader-${Date.now()}` })); return f; })()}`,
    `${BASE}/api/reviews/${reviewId}/withdraw`], { encoding: 'utf8' }),
);
check('非作者撤回被拒（403）', readerWithdraw.ok === false && readerWithdraw.error?.code === 'forbidden',
  JSON.stringify(readerWithdraw.error?.code ?? readerWithdraw));

check('作者撤回已生效', resolveVisibilityInTx(db, reviewId).withdrawn === true, JSON.stringify(resolveVisibilityInTx(db, reviewId)));
const afterWithdraw = get(`/api/reviews/${reviewId}`);
check('撤回后公开详情 → 404 且不返回正文',
  afterWithdraw.ok === false && afterWithdraw.error?.code === 'target_unavailable',
  JSON.stringify(afterWithdraw.error?.code ?? afterWithdraw));

const listAfter = get('/api/reviews');
const stillListed = (listAfter.data?.items ?? []).some((r) => r.reviewId === reviewId);
check('撤回后该评测不再出现在公开列表', stillListed === false, `listed=${stillListed}`);

db.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n==== HTTP 写入验收：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length === 0 ? 0 : 1);
