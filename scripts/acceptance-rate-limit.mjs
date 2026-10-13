#!/usr/bin/env node
/**
 * 频控的 HTTP 验收（`参数与管理规则.md` 第 3 节）。
 *
 * 对**真实运行中的服务**发真请求，验三件事：
 *   1. **同一 requestKey 反复提交不另算额度**（幂等重放要退还）——
 *      连续 5 次同键提交不得出现 429；
 *   2. 5 次**新的**评论提交之后，第 6 次必须 **429 + retry_after_seconds**
 *      （错误码 rate_limited，不是笼统的 500/400）；
 *   3. 超限信息要能指导用户等待（秒数 > 0）。
 *
 * 前置：dev server 在跑（默认 http://127.0.0.1:3100）。脚本自己造一份"已公开的评测"当评论目标
 * （直接写库，走与测试夹具同一条路径），所以**不依赖库里已有数据**。
 * 每次用**唯一的登录昵称**，因此可重复运行（否则一分钟内第二次跑会一开始就带着额度）。
 *
 * 用法：npx tsx scripts/acceptance-rate-limit.mjs
 *      DSH_ACCEPTANCE_BASE=http://127.0.0.1:3211 npx tsx scripts/acceptance-rate-limit.mjs
 *
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDbPath } from '../src/server/platform/db.ts';
import { insertPlugin, insertRepository, insertReview, insertReviewRevision, insertUser } from '../tests/support/db.ts';

const BASE = (process.env.DSH_ACCEPTANCE_BASE ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const RULE_POINTS = 5; // 参数与管理规则.md 第 24 行：每用户每分钟 5 次

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    failures.push(label + (detail ? `（${detail}）` : ''));
    console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'rl-'));

/**
 * 带 Cookie 罐的请求（复用 curl：与既有验收脚本同一套做法）。
 *
 * ⚠️ **响应体走文件、stdout 只留状态码**：早期版本把 body 和 `-w '\n%{http_code}'` 混在 stdout 里一起解析，
 * 结果 curl 在 `Expect: 100-continue` 那一步会先打出 `000`，把 JSON 前缀污染成 `\n000\n000{...}`，
 * 导致"登录明明 200 成功"却被判成失败（踩过）。分开之后互不干扰。
 */
function call(method, path, body, jar) {
  const outFile = join(dir, `o-${Math.random().toString(16).slice(2)}.json`);
  const args = ['-s', '-b', jar, '-c', jar, '-X', method, '-o', outFile, '-w', '%{http_code}', `${BASE}${path}`];
  if (body !== undefined) {
    const f = join(dir, `b-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(body));
    args.splice(args.length - 1, 0, '-H', 'content-type: application/json', '--data-binary', `@${f}`);
  }
  const statusRaw = execFileSync('curl.exe', args, { encoding: 'utf8' }).trim();
  const status = Number(statusRaw.split('\n').pop());
  let text = '';
  try {
    text = readFileSync(outFile, 'utf8');
  } catch {
    /* 没有响应体（例如连接失败） */
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（例如 404 页面）保持 null */
  }
  return { status, json, text };
}

console.log(`频控 HTTP 验收 → ${BASE}\n`);

// ---- 造一个已公开的评测当评论目标（直接写库；与站点用**同一个库文件**）----
const dbFile = resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
const authorId = insertUser(db, { nickname: `频控验收作者-${Date.now().toString(36)}` });
const repoId = insertRepository(db, `gh-ratelimit-${Date.now().toString(36)}`);
const pluginId = insertPlugin(db, repoId);
const reviewId = insertReview(db, { authorId, pluginId });
const revisionId = insertReviewRevision(db, {
  reviewId,
  pluginId,
  revisionNumber: 1,
  title: '频控验收用评测',
  body: '这条评测由 scripts/acceptance-rate-limit.mjs 生成，用于验证评论频控。',
});
db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
db.close();
console.log(`  评论目标评测：${reviewId}\n`);

// ---- 登录（每次唯一的 provider 身份 → 独立额度，可重复运行）----
// 契约：/api/testing/session 要 providerUserId + providerUsername（不是 nickname）。
const jar = join(dir, 'cookies.txt');
const runId = Date.now().toString(36);
const login = call(
  'POST',
  '/api/testing/session',
  { providerUserId: `rl-${runId}`, providerUsername: `rl-${runId}`, displayName: '频控验收账号' },
  jar,
);
check('测试通道登录成功', login.json?.ok === true, `userId=${login.json?.data?.userId ?? '?'}`);
if (login.json?.ok !== true) {
  // 把原始响应当场打出来：登录失败时不打印原文，后面只能靠猜（踩过）。
  console.log(`  ! 登录响应 HTTP ${login.status}，原始内容：${login.text.slice(0, 300) || '(空)'}`);
  console.log('\n（登录失败，后面全部跳过：请确认 dev server 在跑且测试登录通道开启）');
  process.exitCode = 1;
} else {
  const commentUrl = `/api/content/${reviewId}/comments`;

  // ---- 1) 同一 requestKey + **完全相同的内容** → 第一次新建，其余是幂等重放 ----
  // 注意：重放必须是"同键**同摘要**"。如果正文变了，那是 key_reused（409），不是重放 —— 见第 3 步。
  const replayKey = `rl-replay-${runId}`;
  const replayBody = '同键重复提交（正文完全一致）';
  const first = call('POST', commentUrl, { body: replayBody, requestKey: replayKey }, jar);
  check('第一次提交是真的新建（created=true）', first.json?.data?.created === true, `status=${first.status}`);
  const firstCommentId = first.json?.data?.commentId ?? null;

  let replaysOk = true;
  let replayDetail = [];
  for (let i = 0; i < RULE_POINTS - 1; i += 1) {
    const r = call('POST', commentUrl, { body: replayBody, requestKey: replayKey }, jar);
    replayDetail.push(`${r.status}/created=${r.json?.data?.created}`);
    const sameComment = r.json?.data?.commentId === firstCommentId;
    if (r.status !== 202 || r.json?.data?.created !== false || !sameComment) replaysOk = false;
  }
  check(
    `同键同内容再打 ${RULE_POINTS - 1} 次 → 全部 202 且 created=false，并返回**原来那条**评论`,
    replaysOk,
    replayDetail.join(','),
  );

  // ---- 2) 同键但**换了正文** → 409 request_key_reused（设计如此，不是重放）----
  const reused = call('POST', commentUrl, { body: '换了正文就不算重放', requestKey: replayKey }, jar);
  check(
    '同键不同摘要 → 409 request_key_reused（不冒充重放）',
    reused.status === 409 && reused.json?.error?.code === 'request_key_reused',
    `status=${reused.status} code=${reused.json?.error?.code}`,
  );

  // ---- 3) 用新键补满额度（重放块净消耗 1 次，还差 4 次）----
  // 被拒/失败的请求不占额度（路由会退还），所以上面的 409 不影响这里的记账。
  let used = 1;
  while (used < RULE_POINTS) {
    const r = call('POST', commentUrl, { body: `新提交 ${used + 1}`, requestKey: `rl-new-${runId}-${used}` }, jar);
    check(`第 ${used + 1} 次新提交通过`, r.status === 202, `status=${r.status}`);
    used += 1;
  }

  // ---- 4) 第 6 次新提交 → 429 + 明确等待信息 ----
  const over = call('POST', commentUrl, { body: '这次应该被拒', requestKey: `rl-over-${runId}` }, jar);
  check('额度用尽后第 6 次新提交 → HTTP 429', over.status === 429, `status=${over.status}`);
  check(
    '错误码是 rate_limited（不是笼统的 500/400）',
    over.json?.error?.code === 'rate_limited',
    `code=${over.json?.error?.code}`,
  );
  const retry = Number(over.json?.error?.context?.retry_after_seconds ?? 0);
  check('给出明确等待秒数（0 < 秒数 ≤ 60）', retry > 0 && retry <= 60, `retry_after_seconds=${retry}`);
  check(
    '上限与窗口也一并给出（便于前端提示）',
    Number(over.json?.error?.context?.limit) === 5 && Number(over.json?.error?.context?.window_seconds) === 60,
    `limit=${over.json?.error?.context?.limit} window=${over.json?.error?.context?.window_seconds}`,
  );
}

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
