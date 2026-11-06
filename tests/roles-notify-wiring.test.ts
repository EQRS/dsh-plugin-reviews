/**
 * 审核结果通知：审核动作真的发出了通知，而不只是"有两个投递函数摆着"。
 *
 * 为什么单独一个文件：R4 交付了 deliverRoleApplicationResultNotification /
 * deliverPluginClaimResultNotification，但调用方（审核动作）在另一个工作包里。
 * 两边各自绿、合起来没接上，是这类跨包协作最典型的翻车方式——所以这里从
 * **审核动作**出发断言，直接查 notifications 表。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, insertRepository, insertPlugin, insertReview, insertReviewRevision, type TestDb } from './support/db';
import { createRoleService } from '../src/server/modules/roles/service';
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
  return {
    db,
    admin,
    alice,
    roles: createRoleService({ db }),
    ownership: createPluginOwnershipService({ db }),
  };
}

function notificationsFor(db: TestDb['db'], userId: string) {
  return db
    .prepare('SELECT kind, detail, link_url, deduplication_key FROM notifications WHERE recipient_id = ? ORDER BY created_at')
    .all(userId) as Array<{ kind: string; detail: string | null; link_url: string | null; deduplication_key: string }>;
}

/**
 * 造一篇**已发布**的评测，让 reviewer 资格成立。
 *
 * 必须先把 published_revision_id 指到那个修订上——资格判定看的就是它非空
 * （设计 §4.1）。只建 content_entities 是不够的，那只是草稿状态。
 */
function givePublishedReview(db: TestDb['db'], userId: string) {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo);
  const reviewId = insertReview(db, { authorId: userId, pluginId: plugin });
  const revId = insertReviewRevision(db, { reviewId, pluginId: plugin, revisionNumber: 1 });
  db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revId, reviewId);
  return reviewId;
}

describe('身份申请结果通知', () => {
  it('审核通过 → 申请人收到 role_application_result，链接指向 /me/settings', async () => {
    const { db, admin, alice, roles } = setup();
    givePublishedReview(db, alice);

    const app = await roles.applyForRole(caller(db, alice), 'reviewer', null);
    await roles.reviewApplication(caller(db, admin), app.id, 'approve', '材料齐全');

    const rows = notificationsFor(db, alice);
    const hit = rows.find((r) => r.kind === 'role_application_result');
    expect(hit).toBeTruthy();
    expect(hit!.link_url).toBe('/me/settings');
    expect(hit!.detail).toContain('通过');
  });

  it('驳回 → 通知里带驳回理由', async () => {
    const { db, admin, alice, roles } = setup();
    givePublishedReview(db, alice);

    const app = await roles.applyForRole(caller(db, alice), 'reviewer', null);
    await roles.reviewApplication(caller(db, admin), app.id, 'reject', '测评内容太空泛');

    const hit = notificationsFor(db, alice).find((r) => r.kind === 'role_application_result');
    expect(hit).toBeTruthy();
    expect(hit!.detail).toContain('测评内容太空泛');
  });

  it('通知与审核结论在同一事务：审核失败时不产生通知', async () => {
    const { db, admin, alice, roles } = setup();
    givePublishedReview(db, alice);
    const app = await roles.applyForRole(caller(db, alice), 'reviewer', null);
    await roles.reviewApplication(caller(db, admin), app.id, 'approve', null);

    // 同一申请再审一次会被拒（已处理过），不该再发第二条通知
    const before = notificationsFor(db, alice).filter((r) => r.kind === 'role_application_result').length;
    await expect(roles.reviewApplication(caller(db, admin), app.id, 'reject', 'x')).rejects.toThrow();
    const after = notificationsFor(db, alice).filter((r) => r.kind === 'role_application_result').length;
    expect(after).toBe(before);
  });
});

describe('插件认领结果通知', () => {
  it('认领通过 → 申请人收到 plugin_claim_result，链接指向 /me/my-plugins', async () => {
    const { db, admin, alice, ownership } = setup();
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);

    await ownership.claimPlugin(caller(db, alice), plugin, { note: '我是协作者' });
    const queue = await ownership.listQueue(caller(db, admin), 'pending');
    expect(queue).toHaveLength(1);

    await ownership.reviewClaim(caller(db, admin), queue[0]!.ownershipId, 'verify', null);

    const hit = notificationsFor(db, alice).find((r) => r.kind === 'plugin_claim_result');
    expect(hit).toBeTruthy();
    expect(hit!.link_url).toBe('/me/my-plugins');
    expect(hit!.detail).toContain('通过');
  });

  it('认领驳回 → 通知里带理由', async () => {
    const { db, admin, alice, ownership } = setup();
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);

    await ownership.claimPlugin(caller(db, alice), plugin, { note: 'x' });
    const queue = await ownership.listQueue(caller(db, admin), 'pending');
    await ownership.reviewClaim(caller(db, admin), queue[0]!.ownershipId, 'reject', '无法核实你是维护者');

    const hit = notificationsFor(db, alice).find((r) => r.kind === 'plugin_claim_result');
    expect(hit).toBeTruthy();
    expect(hit!.detail).toContain('无法核实你是维护者');
  });

  it('GitHub 账号自动通过不走审核 → 不发通知（没人审核，也就没有结果可发）', async () => {
    const { db, alice, ownership } = setup();
    const repo = insertRepository(db);
    db.prepare('UPDATE repositories SET owner_login = ? WHERE id = ?').run('alicedev', repo);
    db.prepare('UPDATE repositories SET full_name = ? WHERE id = ?').run('alicedev/repo', repo);
    const plugin = insertPlugin(db, repo);
    const now = Date.now();
    db.prepare(
      `INSERT INTO external_identities (id, user_id, provider, provider_user_id, provider_username, profile_url, created_at, synced_at)
       VALUES ('ei1', ?, 'github', 'gh1', 'alicedev', 'https://github.com/alicedev', ?, ?)`,
    ).run(alice, now, now);

    const r = await ownership.claimPlugin(caller(db, alice), plugin, {});
    expect(r.autoVerified).toBe(true);
    expect(notificationsFor(db, alice).filter((x) => x.kind === 'plugin_claim_result')).toHaveLength(0);
  });
});
