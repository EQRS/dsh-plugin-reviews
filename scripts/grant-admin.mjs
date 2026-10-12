// 指定 / 撤销「管理员」——最小切片没有后台授予界面，这一步由部署者在本机执行。
//
// 为什么需要它：`/admin` 只能看见待办列表，而没有管理员就什么都审不了；
// 而站内**没有任何**提权入口（那是刻意的：谁能自己把自己变成管理员才是漏洞）。
// 在它之前，唯一办法是手工拼 SQL（验收脚本就是这么干的：UPDATE users SET role='admin'）。
//
// 用法（在项目根目录执行，读的库与站点相同：DSH_REVIEW_DB_PATH，默认 .data/app.sqlite）：
//   node scripts/grant-admin.mjs --list
//   node scripts/grant-admin.mjs --github-login liceses
//   node scripts/grant-admin.mjs --user-id 01a1...
//   node scripts/grant-admin.mjs --user-id 01a1... --revoke
//
// 前置：目标用户必须**已经登录过一次**（users 行由首次 GitHub 登录建立），
// 否则脚本给不出可指定的对象——这不是限制，而是因为管理员身份挂在站内用户上。
//
// 纪律（对照 idea.md 第 344 行「系统确保至少保留一个管理员」）：
//   --revoke 在会把最后一个可用管理员降级时**拒绝执行**，且不做部分写入。

import Database from 'better-sqlite3';
import { dirname, isAbsolute, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

function resolveDbPath() {
  const raw = process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite';
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

function parseArgs(argv) {
  const out = { list: false, revoke: false, githubLogin: null, userId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--revoke') out.revoke = true;
    else if (a === '--github-login') out.githubLogin = argv[++i] ?? null;
    else if (a === '--user-id') out.userId = argv[++i] ?? null;
    else {
      console.error(`不认识参数：${a}`);
      console.error('用法：node scripts/grant-admin.mjs [--list | --github-login <login> | --user-id <uuid>] [--revoke]');
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const file = resolveDbPath();
const db = new Database(file);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function listAdminCandidates() {
  console.log(`库：${file}`);
  const rows = db
    .prepare(
      `SELECT u.id, u.nickname, u.role, u.account_status,
              ei.provider_username, u.last_login_at
         FROM users u
         LEFT JOIN external_identities ei ON ei.user_id = u.id AND ei.provider = 'github'
        ORDER BY (u.role = 'admin') DESC, u.created_at ASC`,
    )
    .all();

  if (rows.length === 0) {
    console.log('库里还没有任何用户 —— 让目标账号先在站点上登录一次，再来指定。');
    return;
  }
  console.log('');
  console.log('  role   账户      GitHub 账号           昵称                 站内 ID');
  for (const r of rows) {
    const role = r.role === 'admin' ? '管理员' : '普通  ';
    const status = r.account_status === 'active' ? '' : '（已禁用）';
    console.log(
      `  ${role} ${status.padEnd(8)} ${String(r.provider_username ?? '(未绑定)').padEnd(20)} ${String(r.nickname).padEnd(20)} ${r.id}`,
    );
    if (r.last_login_at === null) console.log('          ↑ 从未登录过');
  }
  const admins = rows.filter((r) => r.role === 'admin' && r.account_status === 'active').length;
  console.log('');
  console.log(`当前可用管理员：${admins} 个${admins === 0 ? '（没人能审内容 —— 至少指定一个）' : ''}`);
}

/** 定位目标用户：按 GitHub 登录名（不区分大小写）或站内 ID。 */
function findUser() {
  if (args.userId) {
    const row = db.prepare('SELECT id, nickname, role, account_status FROM users WHERE id = ?').get(args.userId);
    if (!row) throw new Error(`找不到站内用户 ${args.userId}。用 --list 看现有用户。`);
    return row;
  }
  if (args.githubLogin) {
    const row = db
      .prepare(
        `SELECT u.id, u.nickname, u.role, u.account_status
           FROM users u
           JOIN external_identities ei ON ei.user_id = u.id
          WHERE ei.provider = 'github' AND lower(ei.provider_username) = lower(?)`,
      )
      .get(args.githubLogin);
    if (!row) {
      throw new Error(
        `找不到 GitHub 账号 ${args.githubLogin}：该账号还没登录过本站（users 行由首次登录建立）。让 TA 先登录一次，再用 --list 确认。`,
      );
    }
    return row;
  }
  throw new Error('请指定 --github-login <login> 或 --user-id <uuid>（--list 查看候选）。');
}

try {
  if (args.list || (!args.githubLogin && !args.userId)) {
    listAdminCandidates();
    process.exit(0);
  }

  const user = findUser();
  const now = Date.now();

  if (args.revoke) {
    if (user.role !== 'admin') {
      console.log(`${user.nickname}（${user.id}）本来就不是管理员，无需撤销。`);
      process.exit(0);
    }
    const remaining = db
      .prepare(`SELECT count(*) AS c FROM users WHERE role = 'admin' AND account_status = 'active' AND id <> ?`)
      .get(user.id).c;
    if (remaining === 0) {
      throw new Error(
        `拒绝执行：${user.nickname}（${user.id}）是最后一个可用管理员，降级后没人能审内容。请先指定另一个管理员。`,
      );
    }
    db.prepare(
      `UPDATE users SET role = 'user', management_version = management_version + 1, updated_at = ?
        WHERE id = ? AND role = 'admin'`,
    ).run(now, user.id);
    console.log(`已撤销管理员：${user.nickname}（${user.id}）；剩余可用管理员 ${remaining} 个。`);
    process.exit(0);
  }

  if (user.role === 'admin') {
    console.log(`${user.nickname}（${user.id}）已经是管理员，没有改动。`);
    process.exit(0);
  }
  // 禁用账户不授予：否则会造出一个"是管理员但登不进来"的空位。
  if (user.account_status !== 'active') {
    throw new Error(`拒绝执行：${user.nickname}（${user.id}）的账户状态是 ${user.account_status}，不能授予管理员。`);
  }

  db.prepare(
    `UPDATE users SET role = 'admin', management_version = management_version + 1, updated_at = ?
      WHERE id = ? AND role = 'user'`,
  ).run(now, user.id);
  console.log(`已指定管理员：${user.nickname}（${user.id}）。`);
  listAdminCandidates();
} catch (e) {
  console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  db.close();
}
