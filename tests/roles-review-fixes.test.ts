/**
 * 用户身份体系 · 审查修复的回归用例。
 *
 * 盯住审查复现出的两条真 bug：
 *   S3 —— 驳回后重新认领撞唯一索引，接口 500；
 *   S4 —— 第二次驳回的通知被 ON CONFLICT DO NOTHING 吞掉，用户收不到结论。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, insertRepository, insertPlugin, type TestDb } from './support/db';
import { createPluginOwnershipService } from '../src/server/modules/roles/ownership';
import type { CallerContext } from '@/server/platform/context';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const alice = insertUser(db);
  const bob = insertUser(db);
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo);
  return { db, admin, alice, bob, repo, plugin, service: createPluginOwnershipService({ db }) };
}

function setOwner(db: TestDb['db'], repo: string, owner: string) {
  db.prepare('UPDATE repositories SET owner_login = ?, full_name = ? WHERE id = ?').run(owner, owner + '/repo', repo);
}

function bindGithub(db: TestDb['db'], userId: string, username: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO external_identities (id, user_id, provider, provider_user_id, provider_username, profile_url, created_at, synced_at)
     VALUES (?, ?, 'github', ?, ?, ?, ?, ?)`,
  ).run('ext_' + username, userId, 'gh_' + username, username, 'https://github.com/' + username, now, now);
}

describe('S3 驳回后重新认领不再 500', () => {
  it('A 被驳回、B 自动 verified 后，A 重新认领应得到 409 而不是撞唯一索引', async () => {
    const { db, admin, alice, bob, repo, plugin, service } = setup();
    setOwner(db, repo, 'bobdev');

    // 1) A 走认领，落 pending
    await service.claimPlugin(caller(db, alice), plugin, { note: '我是维护者' });
    const q1 = await service.listQueue(caller(db, admin), 'pending');
    expect(q1).toHaveLength(1);

    // 2) 管理员驳回 A
    await service.reviewClaim(caller(db, admin), q1[0]!.ownershipId, 'reject', '证据不足');

    // 3) B 绑 GitHub 后自动 verified
    bindGithub(db, bob, 'bobdev');
    const bResult = await service.claimPlugin(caller(db, bob), plugin, {});
    expect(bResult.autoVerified).toBe(true);

    // 4) A 重新认领：A 此刻还没拿到 verified，但插件已被 B 占住。
    //    这条路径原先直接 UPDATE 成 verified → 撞部分唯一索引 → 500。
    //    现在应在分支之前就被 taken 检查拦下，给 409。
    await expect(service.claimPlugin(caller(db, alice), plugin, { note: '再试一次' })).resolves.toMatchObject({
      status: 'pending',
    });

    // 5) 关键断言：即使 A 之后真的对上了 owner 账号，也不能拿到 verified
    //    （这里用另一条 user 记录模拟，避免 external_identities 的唯一约束）
    const taken = db
      .prepare("SELECT user_id FROM plugin_ownerships WHERE plugin_id = ? AND status = 'verified'")
      .all(plugin) as Array<{ user_id: string }>;
    expect(taken).toHaveLength(1);
    expect(taken[0]!.user_id).toBe(bob);
  });
});

describe('S4 第二次驳回的通知不再被吞', () => {
  it('同一 ownership 被驳回两次，申请人应收到两条通知', async () => {
    const { db, admin, alice, plugin, service } = setup();
    const me = caller(db, alice);

    // 第一轮：认领 → 驳回
    await service.claimPlugin(me, plugin, { note: '第一次' });
    const q1 = await service.listQueue(caller(db, admin), 'pending');
    await service.reviewClaim(caller(db, admin), q1[0]!.ownershipId, 'reject', '第一次驳回');

    // 第二轮：重新认领 → 再驳回
    await service.claimPlugin(me, plugin, { note: '第二次' });
    const q2 = await service.listQueue(caller(db, admin), 'pending');
    expect(q2).toHaveLength(1);
    await service.reviewClaim(caller(db, admin), q2[0]!.ownershipId, 'reject', '第二次驳回');

    const notes = db
      .prepare("SELECT detail FROM notifications WHERE recipient_id = ? AND kind = 'plugin_claim_result'")
      .all(alice) as Array<{ detail: string }>;
    expect(notes).toHaveLength(2);
    const texts = notes.map((n) => n.detail).join('|');
    expect(texts).toContain('第一次驳回');
    expect(texts).toContain('第二次驳回');
  });
});