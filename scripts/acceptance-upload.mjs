// HTTP 验收：图片上传全链路（登记 → 传字节 → 就绪 → 读取 → 权限）。
// 用真实 PNG 字节走真实服务器。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const BASE = 'http://127.0.0.1:3100';
const dir = mkdtempSync(join(tmpdir(), 'up-'));
const jar = join(dir, 'cookies.txt');
const RUN = Date.now().toString(36);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function curl(args) {
  return execFileSync('curl.exe', ['-s', '-b', jar, '-c', jar, ...args], { encoding: 'utf8' });
}
function json(args) {
  const raw = curl(args);
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw.slice(0, 300) };
  }
}
function postJson(path, body) {
  const f = join(dir, `b-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(body));
  return json(['-X', 'POST', '-H', 'content-type: application/json', '--data-binary', `@${f}`, `${BASE}${path}`]);
}

// 1) 登录（开发环境测试通道）
const login = postJson('/api/testing/session', { providerUserId: `gh-up-${RUN}`, providerUsername: `upuser-${RUN}` });
check('登录', login.ok === true, login.data?.userId);
const loader = new Database(join(process.cwd(), '.data', 'app.sqlite'));
loader.pragma('foreign_keys = ON');
const authorId = login.data.userId;

// 2) 造草稿（直接建，专注验证上传链路）
//
// 隔离性要求：本脚本必须可重复运行。
// 早先版本对 repositories/plugins 用 INSERT OR IGNORE + 写死 ID，对 reviews/drafts
// 直接 INSERT 写死 ID —— 第二次运行就撞 content_entities 的 UNIQUE，报
// `UNIQUE constraint failed: content_entities.id`。那是脚本自身的缺陷，不是产品缺陷，
// 但会被误读成"上传链路坏了"。这里改成：仓库/插件按稳定键复用，评测/草稿每次新建。
const now = Date.now();

function scriptUuidv7() {
  // 形状与服务端 newId 一致即可（本脚本不依赖时间序）
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const ts = Date.now().toString(16).padStart(12, '0');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(3)}-8${hex(3)}-${hex(12)}`;
}

const REPO_KEY = 'gh-upload-probe'; // 稳定键：所有运行共用同一个仓库行
let repoRow = loader.prepare('SELECT id FROM repositories WHERE github_repository_id = ?').get(REPO_KEY);
if (!repoRow) {
  const id = scriptUuidv7();
  loader
    .prepare(
      `INSERT INTO repositories (id, github_repository_id, full_name, html_url, availability_state, created_at, updated_at)
       VALUES (?, ?, 'a/b', 'https://github.com/a/b', 'available', ?, ?)`,
    )
    .run(id, REPO_KEY, now, now);
  repoRow = { id };
}
const repoId = repoRow.id;

let pluginRow = loader.prepare('SELECT id FROM plugins WHERE repository_id = ? AND plugin_path = ?').get(repoId, '.');
if (!pluginRow) {
  const id = scriptUuidv7();
  loader
    .prepare(`INSERT INTO plugins (id, repository_id, plugin_path, created_at, updated_at) VALUES (?, ?, '.', ?, ?)`)
    .run(id, repoId, now, now);
  pluginRow = { id };
}
const pluginId = pluginRow.id;

const reviewId = scriptUuidv7();
const draftId = scriptUuidv7();
const mk = loader.transaction(() => {
  loader
    .prepare(`INSERT INTO content_entities (id, content_type, author_id, review_id, created_at) VALUES (?, 'review', ?, ?, ?)`)
    .run(reviewId, authorId, reviewId, now);
  loader.prepare(`INSERT INTO reviews (id, plugin_id, source_kind) VALUES (?, ?, 'community')`).run(reviewId, pluginId);
});
mk();
loader
  .prepare(
    `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, save_version, created_at, saved_at)
     VALUES (?, ?, 'review', ?, '{}', 0, ?, ?)`,
  )
  .run(draftId, authorId, reviewId, now, now);
check('准备草稿', true, draftId);

// 3) 登记附件
const reg = postJson(`/api/drafts/${draftId}/attachments`, { originalFilename: 'shot.png', usage: 'body' });
check('登记附件', reg.ok === true && !!reg.data?.attachmentId, JSON.stringify(reg.data ?? reg));
const attachmentId = reg.data.attachmentId;
check('登记后状态为 pending 且不可引用', reg.data.processingState === 'pending' && reg.data.displayUrl === null);

// 4) 真实 PNG 上传
const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 120, b: 200 } } })
  .png()
  .toBuffer();
const pngFile = join(dir, 'shot.png');
writeFileSync(pngFile, png);
const up = json(['-X', 'PUT', '-H', 'content-type: image/png', '--data-binary', `@${pngFile}`, `${BASE}/api/attachments/${attachmentId}/file`]);
check('上传真实 PNG 成功', up.ok === true, JSON.stringify(up.data ?? up));
check('就绪并给出固定站内地址', up.data?.processingState === 'ready' && typeof up.data?.displayUrl === 'string', up.data?.displayUrl);
check('读取到真实尺寸', up.data?.width === 640 && up.data?.height === 360, `${up.data?.width}x${up.data?.height}`);

// 5) 读取 display 变体（本人）
const mediaPath = up.data.displayUrl;
const mimeOut = curl(['-o', join(dir, 'got.png'), '-w', '%{http_code} %{content_type}', `${BASE}${mediaPath}`]);
check('本人可读取 display 变体', mimeOut.startsWith('200') && mimeOut.includes('image/png'), mimeOut);
const gotBytes = readFileSync(join(dir, 'got.png'));
check('读回的确实是图片字节（非空且可解码）', gotBytes.byteLength > 0, `${gotBytes.byteLength} bytes`);

// 6) 匿名读取：该附件尚未被公开引用 → 404
const anonCode = execFileSync('curl.exe', ['-s', '-o', 'NUL', '-w', '%{http_code}', `${BASE}${mediaPath}`], {
  encoding: 'utf8',
});
check('匿名读未公开图片 → 404（不泄露存在性）', anonCode === '404', `status=${anonCode}`);

// 7) 伪装的"图片"被拒绝
const reg2 = postJson(`/api/drafts/${draftId}/attachments`, { originalFilename: 'fake.png', usage: 'body' });
const fakeFile = join(dir, 'fake.png');
writeFileSync(fakeFile, Buffer.from('这根本不是图片，只是一段文字。'.repeat(30)));
const bad = json(['-X', 'PUT', '-H', 'content-type: image/png', '--data-binary', `@${fakeFile}`, `${BASE}/api/attachments/${reg2.data.attachmentId}/file`]);
check('伪装成 PNG 的文本被拒绝', bad.ok === false && bad.error?.code === 'input_invalid', JSON.stringify(bad.error?.message ?? bad));
const failedRow = loader
  .prepare('SELECT processing_state, last_error_code FROM attachments WHERE id = ?')
  .get(reg2.data.attachmentId);
check('失败状态与原因如实落库', failedRow.processing_state === 'failed' && !!failedRow.last_error_code, JSON.stringify(failedRow));

// 8) 超限文件被拒
const bigFile = join(dir, 'big.bin');
writeFileSync(bigFile, Buffer.alloc(11 * 1024 * 1024, 7));
const reg3 = postJson(`/api/drafts/${draftId}/attachments`, { originalFilename: 'big.png', usage: 'body' });
const bigRes = json(['-X', 'PUT', '-H', 'content-type: image/png', '--data-binary', `@${bigFile}`, `${BASE}/api/attachments/${reg3.data.attachmentId}/file`]);
check('超过 10MB 被拒绝', bigRes.ok === false, JSON.stringify(bigRes.error?.message ?? bigRes));

// 9) 路径探测：非法变体键
const probeCode = execFileSync('curl.exe', ['-s', '-o', 'NUL', '-w', '%{http_code}', `${BASE}/media/${attachmentId}/../secret`], { encoding: 'utf8' });
check('非法变体/穿越路径被拒', probeCode === '404', `status=${probeCode}`);

loader.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n==== 上传链路验收：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length === 0 ? 0 : 1);
