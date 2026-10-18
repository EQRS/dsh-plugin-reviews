// 造一条**保持公开**的评测，用于确认页面真的渲染真实数据（不是空壳）。
// 与验收脚本分开：这里刻意不撤回。
import { createTestDb } from '../tests/support/db.ts';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const BASE = 'http://127.0.0.1:3100';
const dir = mkdtempSync(join(tmpdir(), 'demo-'));
const jar = join(dir, 'c.txt');
const db = new Database(join(process.cwd(), '.data', 'app.sqlite'));
db.pragma('foreign_keys = ON');

const now = Date.now();
const RUN = Date.now().toString(36);

// 种子：仓库 + 插件
const repoId = '01920000-0000-7000-8000-0000000000b1';
const pluginId = '01920000-0000-7000-8000-0000000000b2';
db.prepare(
  `INSERT OR IGNORE INTO repositories (id, github_repository_id, full_name, html_url, availability_state, created_at, updated_at)
   VALUES (?, 'gh-demo-1', 'acme/dsh-memory-demo', 'https://github.com/acme/dsh-memory-demo', 'available', ?, ?)`,
).run(repoId, now, now);
db.prepare(
  `INSERT OR IGNORE INTO plugins (id, repository_id, plugin_path, created_at, updated_at) VALUES (?, ?, '.', ?, ?)`,
).run(pluginId, repoId, now, now);

function curlCall(method, path, body, jarFile = jar) {
  const f = join(dir, `b-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(body));
  return JSON.parse(
    execFileSync('curl.exe', ['-s', '-b', jarFile, '-c', jarFile, '-X', method,
      '-H', 'content-type: application/json', '--data-binary', `@${f}`, `${BASE}${path}`], { encoding: 'utf8' }),
  );
}
const curlPost = (path, body, jarFile) => curlCall('POST', path, body, jarFile);

// 作者登录 → 草稿 → 保存 → 提交
curlPost('/api/testing/session', { providerUserId: `gh-demo-author-${RUN}`, providerUsername: `demoauthor-${RUN}` });
const draft = curlPost('/api/drafts', { pluginId, requestKey: `demo-draft-${RUN}` });
curlCall('PUT', '/api/drafts', {
  draftId: draft.data.draftId, expectedVersion: 0, requestKey: `demo-save-${RUN}`,
  title: '演示评测：用 dsh-memory 整理科研资料',
  pluginId, pluginVersion: { kind: 'known', value: '1.2.0' }, dshVersion: { kind: 'known', value: '0.3.1' },
  body: [{ key: 's1', markdown: '## 用它做什么\n\n把散落的文献笔记整理成可检索的资料库。\n\n## 效果怎么样\n\n检索很快，中文两字词也能命中。\n\n## 有什么问题\n\n首次索引较慢。' }],
});

// 提交走 PATCH（保存走 PUT，方法语义唯一 —— 见 README §5 缺陷 11）
// 五状态判定自迁移 0009 起必填；演示数据给「真有用」+ 一条证据，
// 这样演示页能同时展示判定徽章与证据链区块（不是空壳）。
const sub = curlCall('PATCH', '/api/drafts', {
  draftId: draft.data.draftId, expectedSaveVersion: 1, requestKey: `demo-submit-${RUN}`,
  title: '演示评测：用 dsh-memory 整理科研资料',
  bodyMarkdown: '## 用它做什么\n\n把散落的文献笔记整理成可检索的资料库。\n\n## 效果怎么样\n\n检索很快，中文两字词也能命中。\n\n## 有什么问题\n\n首次索引较慢。',
  pluginVersion: { kind: 'known', value: '1.2.0' }, dshVersion: { kind: 'known', value: '0.3.1' },
  verdict: 'helpful',
  evidenceRefs: [
    { url: 'https://github.com/acme/dsh-memory-demo', note: '演示用证据：仓库 README 的检索示例' },
  ],
});

// 管理员登录 + 通过
const adminJar = join(dir, 'a.txt');
const af = join(dir, 'a.json');
writeFileSync(af, JSON.stringify({ providerUserId: `gh-demo-admin-${RUN}`, providerUsername: `demoadmin-${RUN}` }));
const adminLogin = JSON.parse(execFileSync('curl.exe', ['-s', '-b', adminJar, '-c', adminJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${af}`, `${BASE}/api/testing/session`], { encoding: 'utf8' }));
db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(adminLogin.data.userId);

const { createModerationService } = await import('../src/server/modules/moderation/index.ts');
const moderation = createModerationService(db);
await moderation.transition(sub.data.submissionId, {
  expectedStateVersion: 0, to: 'manual_review', reason: '内容筛查未配置，转人工。',
});

const mf = join(dir, 'm.json');
writeFileSync(mf, JSON.stringify({
  submissionId: sub.data.submissionId, decision: 'approve',
  reason: '演示数据：环境与过程齐全。', expectedStateVersion: 1, requestKey: `demo-approve-${RUN}`,
}));
const decided = JSON.parse(execFileSync('curl.exe', ['-s', '-b', adminJar, '-c', adminJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${mf}`,
  `${BASE}/api/admin/submissions/${sub.data.submissionId}/decisions`], { encoding: 'utf8' }));

// 发布
const { publishReview } = await import('../src/server/workflows/publish-review.ts');
const outcome = publishReview(sub.data.submissionId, db);

// 评论
const readerJar = join(dir, 'r.txt');
const rf = join(dir, 'r.json');
writeFileSync(rf, JSON.stringify({ providerUserId: `gh-demo-reader-${RUN}`, providerUsername: `demoreader-${RUN}` }));
execFileSync('curl.exe', ['-s', '-b', readerJar, '-c', readerJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${rf}`, `${BASE}/api/testing/session`], { encoding: 'utf8' });
const cf = join(dir, 'c.json');
writeFileSync(cf, JSON.stringify({ body: '问一下：它支持增量索引吗？', requestKey: `demo-comment-${RUN}` }));
const comment = JSON.parse(execFileSync('curl.exe', ['-s', '-b', readerJar, '-c', readerJar, '-X', 'POST',
  '-H', 'content-type: application/json', '--data-binary', `@${cf}`,
  `${BASE}/api/content/${sub.data.reviewId}/comments`], { encoding: 'utf8' }));

console.log('reviewId :', sub.data.reviewId);
console.log('发布     :', JSON.stringify(outcome));
console.log('评论     :', comment.ok === true ? '已提交' : JSON.stringify(comment));
console.log('URL      :', `${BASE}/reviews/${sub.data.reviewId}`);
db.close();
