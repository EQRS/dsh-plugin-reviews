#!/usr/bin/env node
/**
 * 通知 + 评论编辑/删除 的**真 HTTP 端到端验收**。
 *
 * 为什么要有它：单测覆盖到服务层为止，而这批改动的关键风险在**路由层**
 * （鉴权顺序、幂等退还、错误码映射、越权判定），只有发真请求才验得到。
 *
 * 流程（全真）：
 *   1. 造两个用户 + 一篇**已公开**的评测（直接写库，与 acceptance-rate-limit 同法）；
 *   2. 甲评论 → 202；用真 workflow 通过检查并发布（模拟 worker 那一步）；
 *   3. 评测作者 GET /api/me/notifications → 未读 1 条、kind/actor 正确；
 *   4. 作者标记已读 → 未读 0（并且再标一次仍是 0：幂等）；
 *   5. 甲改自己的评论 → 202；发布后公开正文替换、editedAt 非空；
 *   6. 甲删自己的评论 → 200；公开列表里消失（无回复时）；
 *   7. 越权检查：乙去改甲的评论 → 403。
 *
 * 用法：DSH_ACCEPTANCE_BASE=http://127.0.0.1:3100 npx tsx scripts/acceptance-notifications.mjs
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDbPath } from '../src/server/platform/db.ts';
import { insertPlugin, insertRepository, insertReview, insertReviewRevision, insertUser } from '../tests/support/db.ts';
import { publishComment } from '../src/server/workflows/publish-comment.ts';

const BASE = process.env.DSH_ACCEPTANCE_BASE ?? 'http://127.0.0.1:3100';
const dir = mkdtempSync(join(tmpdir(), 'dsh-acc-notif-'));
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
}

function call(method, path, body, jar) {
  const outFile = join(dir, `o-${Math.random().toString(16).slice(2)}.json`);
  const args = ['-s', '-b', jar, '-c', jar, '-X', method, '-o', outFile, '-w', '%{http_code}', `${BASE}${path}`];
  if (body !== undefined) {
    // execFileSync 不经过 shell，JSON 原样作为单个 argv 传入，不需要临时文件、也没有引号问题。
    args.splice(args.length - 1, 0, '-H', 'content-type: application/json', '--data-binary', JSON.stringify(body));
  }
  const status = Number(execFileSync('curl.exe', args, { encoding: 'utf8' }).trim().split('\n').pop());
  let json = null;
  let text = '';
  try {
    text = readFileSync(outFile, 'utf8');
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（例如 404 页面） */
  }
  return { status, json, text };
}

function login(role) {
  const jar = join(dir, `cookie-${role}.txt`);
  const id = `${role}-${Date.now().toString(36)}`;
  const res = call('POST', '/api/testing/session', { providerUserId: id, providerUsername: id, displayName: role }, jar);
  return { jar, userId: res.json?.data?.userId ?? null, status: res.status };
}

console.log(`通知 / 评论编辑删除 验收 → ${BASE}\n`);

// ---- 1) 造数据：两个用户 + 一篇已公开评测 ----
const dbFile = resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');

const authorId = insertUser(db, { nickname: '验收作者' });
const otherId = insertUser(db, { nickname: '验收路人' });
const repoId = insertRepository(db, `gh-acc-notif-${Date.now()}`);
const pluginId = insertPlugin(db, repoId);
const reviewId = insertReview(db, { authorId, pluginId });
const revisionId = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 1 });
db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(
  Date.now(),
  Date.now(),
  reviewId,
);
console.log(`  评测：${reviewId}`);

const author = login('author');
const commenter = login('commenter');
check('两个测试账号登录成功', author.userId !== null && commenter.userId !== null);

// 让"评论者"就是 commenter，作者是 author：把 commenter 账号换成 review 的作者
// （上面的 insertUser 是库内账号，测试登录会新建账号，两者不同 —— 这里直接把
//  review 的 author 改成测试登录取到的用户更省事，但会改动已插入行；
//  改用另一个办法：把评论者的评论目标设成"评论者自己的内容"，这样收件人是他自己 → 不发通知。
//  为了验通知，这里把 review 的 author 改成 author 测试账号。）
db.prepare('UPDATE content_entities SET author_id = ? WHERE id = ?').run(author.userId, reviewId);

// ---- 2) 评论 + 真发布 ----
const created = call('POST', `/api/content/${reviewId}/comments`, { body: '第一版评论', requestKey: `nc-${Date.now()}` }, commenter.jar);
check('发表评论 → 202', created.status === 202, `status=${created.status}`);
const commentId = created.json?.data?.commentId ?? null;
check('返回了评论标识', typeof commentId === 'string');

function approveAndPublish(submissionId) {
  db.prepare("UPDATE content_submissions SET processing_state = 'approved' WHERE id = ?").run(submissionId);
  return publishComment(submissionId, db);
}
const firstPublish = approveAndPublish(created.json?.data?.submissionId);
check('通过检查后发布成功（模拟 worker 那一步）', firstPublish.published === true, JSON.stringify(firstPublish.reason ?? ''));

// ---- 3) 作者收到通知 ----
const inbox = call('GET', '/api/me/notifications', undefined, author.jar);
check('作者能读自己的通知 → 200', inbox.status === 200, `status=${inbox.status}`);
check('未读数 = 1', inbox.json?.data?.unreadCount === 1, `unread=${inbox.json?.data?.unreadCount}`);
check(
  '通知类型与摘要正确',
  inbox.json?.data?.items?.[0]?.kind === 'comment_on_content' &&
    String(inbox.json?.data?.items?.[0]?.excerpt ?? '').includes('第一版评论'),
  `kind=${inbox.json?.data?.items?.[0]?.kind}`,
);
const notificationId = inbox.json?.data?.items?.[0]?.id ?? null;

const anonymousInbox = call('GET', '/api/me/notifications', undefined, join(dir, 'anonymous.txt'));
check('未登录读通知 → 401', anonymousInbox.status === 401, `status=${anonymousInbox.status}`);

// 评论者自己没有收到通知（他不该收到自己那条）
const commenterInbox = call('GET', '/api/me/notifications', undefined, commenter.jar);
check('评论者没有收到自己触发的通知', commenterInbox.json?.data?.unreadCount === 0);

// ---- 4) 已读（含幂等） ----
const read1 = call('POST', '/api/me/notifications/read', { ids: [notificationId] }, author.jar);
check('标记单条已读 → marked 1', read1.json?.data?.marked === 1, `marked=${read1.json?.data?.marked}`);
const read2 = call('POST', '/api/me/notifications/read', { ids: [notificationId] }, author.jar);
check('重复标记 → marked 0（幂等）', read2.json?.data?.marked === 0);
check('未读数归零', (call('GET', '/api/me/notifications', undefined, author.jar).json?.data?.unreadCount ?? -1) === 0);

// ---- 5) 编辑 + 发布 ----
const edited = call(
  'PUT',
  `/api/content/${reviewId}/comments/${commentId}`,
  { body: '改过一遍的评论', requestKey: `ed-${Date.now()}` },
  commenter.jar,
);
check('改自己的评论 → 202', edited.status === 202, `status=${edited.status}`);
const secondPublish = approveAndPublish(edited.json?.data?.submissionId);
check('修改通过检查后发布（替换公开内容）', secondPublish.published === true);

const list = call('GET', `/api/content/${reviewId}/comments`, undefined, commenter.jar);
const item = list.json?.data?.items?.[0];
check('公开正文已替换为新版', item?.body === '改过一遍的评论', `body=${String(item?.body).slice(0, 20)}`);
check('显示"已编辑"（editedAt 非空）', typeof item?.editedAt === 'number' && item.editedAt > 0);

const inboxAfterEdit = call('GET', '/api/me/notifications', undefined, author.jar);
check('编辑不会重复通知（收件箱仍只有 1 条）', inboxAfterEdit.json?.data?.items?.length === 1, `count=${inboxAfterEdit.json?.data?.items?.length}`);

// ---- 6) 越权：路人改别人的评论 ----
const strangerId = insertUser(db, { nickname: '验收陌生人' });
void strangerId;
const forbidden = call(
  'PUT',
  `/api/content/${reviewId}/comments/${commentId}`,
  { body: '我要篡改', requestKey: `bad-${Date.now()}` },
  author.jar, // 作者不是这条评论的作者
);
check('改别人的评论 → 403 forbidden', forbidden.status === 403 && forbidden.json?.error?.code === 'forbidden', `status=${forbidden.status} code=${forbidden.json?.error?.code}`);

// ---- 7) 删除 ----
const removed = call('DELETE', `/api/content/${reviewId}/comments/${commentId}`, undefined, commenter.jar);
check('删自己的评论 → 200 且 deleted=true', removed.status === 200 && removed.json?.data?.deleted === true, `status=${removed.status}`);
const removedAgain = call('DELETE', `/api/content/${reviewId}/comments/${commentId}`, undefined, commenter.jar);
check('再删一次 → alreadyDeleted（幂等，不报错）', removedAgain.json?.data?.alreadyDeleted === true);
const afterDelete = call('GET', `/api/content/${reviewId}/comments`, undefined, commenter.jar);
check('删除后公开列表里没有了（该条无回复）', (afterDelete.json?.data?.items?.length ?? -1) === 0, `items=${afterDelete.json?.data?.items?.length}`);

// ---- 8) 后台接口的鉴权（未登录必须挡住） ----
const anonSettings = call('PUT', '/api/admin/settings', { changes: { 'rate_limits.comment_changes_per_minute': 9 }, reason: 'x', requestKey: 'x' }, join(dir, 'anon2.txt'));
check('未登录改配置 → 403', anonSettings.status === 403, `status=${anonSettings.status}`);
const anonDiscovery = call('POST', '/api/admin/discovery', { requestKey: 'x' }, join(dir, 'anon3.txt'));
check('未登录排发现任务 → 403', anonDiscovery.status === 403, `status=${anonDiscovery.status}`);

db.close();

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
