/**
 * 用户身份体系 · 插件归属（认领）。
 *
 * 这个文件盯住四件最容易写坏的事：
 *   1. GitHub 账号匹配要**忽略大小写**——GitHub 的 username 本身不区分大小写，
 *      严格比较会让一半人匹配不上；
 *   2. 组织仓库自动匹配必须失败、只能走认领——这是设计里最关键的分叉；
 *   3. 一个插件只能有一个 verified 归属人，否则「我的插件」会出现两个人；
 *   4. 被驳回后能重新认领，且理由是给用户看的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, insertRepository, insertPlugin, type TestDb } from './support/db';
import { createPluginOwnershipService } from '../src/server/modules/roles/ownership';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string | null): CallerContext {
  if (userId === null) return { userId: null, role: 'user', accountStatus: 'active' };
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

/** 给仓库设 owner_login（fixture 的企业默认是 owner/repo-xxx，owner 恒为 owner）。 */
function setOwner(db: TestDb['db'], repositoryId: string, ownerLogin: string) {
  db.prepare('UPDATE repositories SET owner_login = ?, full_name = ? WHERE id = ?').run(
    ownerLogin,
    ownerLogin + '/repo',
    repositoryId,
  );
}

/** 给用户绑一个 GitHub 身份。 */
function bindGithub(db: TestDb['db'], userId: string, username: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO external_identities
       (id, user_id, provider, provider_user_id, provider_username, profile_url, created_at, synced_at)
     VALUES (?, ?, 'github', ?, ?, ?, ?, ?)`,
  ).run('ext_' + username, userId, 'gh_' + username, username, 'https://github.com/' + username, now, now);
}

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const alice = insertUser(db);
  const bob = insertUser(db);
  return {
    db,
    admin,
    alice,
    bob,
    service: createPluginOwnershipService({ db }),
  };
}

describe('GitHub 账号匹配', () => {
  it('账号与仓库 owner 相同（忽略大小写）时自动通过，不需要审核', async () => {
    const { db, alice, service } = setup();
    const repo = insertRepository(db);
    setOwner(db, repo, 'AliceDev');
    const plugin = insertPlugin(db, repo);
    bindGithub(db, alice, 'alicedev'); // 小写，仓库 owner 混写

    const result = await service.claimPlugin(caller(db, alice), plugin, {});
    expect(result.autoVerified).toBe(true);
    expect(result.status).toBe('verified');
  });

  it('账号对不上时落 pending，等管理员审', async () => {
    const { db, alice, service } = setup();
    const repo = insertRepository(db);
    setOwner(db, repo, 'someone-else');
    const plugin = insertPlugin(db, repo);
    bindGithub(db, alice, 'alicedev');

    const result = await service.claimPlugin(caller(db, alice), plugin, { note: '我是协作者' });
    expect(result.autoVerified).toBe(false);
    expect(result.status).toBe('pending');
  });

  it('仓库属于组织（站内没有该账号）时永远走认领', async () => {
    const { db, alice, service } = setup();
    const repo = insertRepository(db);
    setOwner(db, repo, 'dsh-org');
    const plugin = insertPlugin(db, repo);
    bindGithub(db, alice, 'alicedev');

    const result = await service.claimPlugin(caller(db, alice), plugin, { note: '我是该组织成员' });
    expect(result.status).toBe('pending');
  });

  it('没绑 GitHub 身份的用户不能自动通过', async () => {
    const { db, alice, service } = setup();
    const repo = insertRepository(db);
    setOwner(db, repo, 'alice');
    const plugin = insertPlugin(db, repo);
    // 不绑 external_identities

    const result = await service.claimPlugin(caller(db, alice), plugin, {});
    expect(result.status).toBe('pending');
  });
});

describe('唯一性与冲突', () => {
  it('一个插件已被认领后，第二个人无法再拿到 verified', async () => {
    const { db, alice, bob, admin, service } = setup();
    const repo = insertRepository(db);
    setOwner(db, repo, 'alicedev');
    const plugin = insertPlugin(db, repo);
    bindGithub(db, alice, 'alicedev');

    // alice 靠 GitHub 匹配直接拿到
    await service.claimPlugin(caller(db, alice), plugin, {});
    // bob 走认领，落 pending
    await service.claimPlugin(caller(db, bob), plugin, { note: '其实是我的' });

    // 管理员想批准 bob 时，必须被「已有归属人」挡住
    const queue = await service.listQueue(caller(db, admin), 'pending');
    expect(queue).toHaveLength(1);
    expect(queue[0]!.userId).toBe(bob);

    await expect(service.reviewClaim(caller(db, admin), queue[0]!.ownershipId, 'verify', null)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.VERSION_CONFLICT,
    );
  });

  it('重复认领同一插件被拒（pending 中）', async () => {
    const { db, alice, service } = setup();
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    await service.claimPlugin(caller(db, alice), plugin, {});
    await expect(service.claimPlugin(caller(db, alice), plugin, {})).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.VERSION_CONFLICT,
    );
  });

  it('已认领的插件再认领被拒', async () => {
    const { db, alice, service } = setup();
    const repo = insertRepository(db);
    setOwner(db, repo, 'alicedev');
    const plugin = insertPlugin(db, repo);
    bindGithub(db, alice, 'alicedev');
    await service.claimPlugin(caller(db, alice), plugin, {});
    await expect(service.claimPlugin(caller(db, alice), plugin, {})).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.VERSION_CONFLICT,
    );
  });
});

describe('列表与审核', () => {
  it('我的插件能看到 pending 与 verified', async () => {
    const { db, alice, service } = setup();
    const repo1 = insertRepository(db);
    setOwner(db, repo1, 'alicedev');
    const p1 = insertPlugin(db, repo1);
    bindGithub(db, alice, 'alicedev');
    await service.claimPlugin(caller(db, alice), p1, {});

    const repo2 = insertRepository(db);
    const p2 = insertPlugin(db, repo2);
    await service.claimPlugin(caller(db, alice), p2, { note: 'x' });

    const mine = await service.listMine(caller(db, alice));
    expect(mine).toHaveLength(2);
    expect(mine.filter((m) => m.ownershipStatus === 'verified')).toHaveLength(1);
    expect(mine.filter((m) => m.ownershipStatus === 'pending')).toHaveLength(1);
  });

  it('驳回后能看到理由，并且能重新认领', async () => {
    const { db, alice, admin, service } = setup();
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    await service.claimPlugin(caller(db, alice), plugin, { note: '第一次' });

    const queue = await service.listQueue(caller(db, admin), 'pending');
    expect(queue).toHaveLength(1);
    await service.reviewClaim(caller(db, admin), queue[0]!.ownershipId, 'reject', '证据不足');

    const mine = await service.listMine(caller(db, alice));
    expect(mine[0]!.ownershipStatus).toBe('rejected');
    expect(mine[0]!.reviewNote).toBe('证据不足');

    // 驳回后能重新认领
    const again = await service.claimPlugin(caller(db, alice), plugin, { note: '补充了证据' });
    expect(again.status).toBe('pending');
  });

  it('非管理员不能看队列、不能审核', async () => {
    const { db, alice, service } = setup();
    await expect(service.listQueue(caller(db, alice), 'pending')).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN,
    );
  });

  it('匿名不能查我的插件', async () => {
    const { db, service } = setup();
    await expect(service.listMine(caller(db, null))).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.UNAUTHENTICATED,
    );
  });

  it('countVerifiedForUser 只数 verified', async () => {
    const { db, alice, service } = setup();
    const repo1 = insertRepository(db);
    setOwner(db, repo1, 'alicedev');
    const p1 = insertPlugin(db, repo1);
    bindGithub(db, alice, 'alicedev');
    await service.claimPlugin(caller(db, alice), p1, {});

    const repo2 = insertRepository(db);
    const p2 = insertPlugin(db, repo2);
    await service.claimPlugin(caller(db, alice), p2, {}); // pending

    expect(await service.countVerifiedForUser(alice)).toBe(1);
  });
});

