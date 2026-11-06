/**
 * 用户身份体系 · 身份服务（测评员 / 开发者）。
 *
 * 设计：docs/项目规划/设计-用户身份体系.md
 *
 * 这个文件盯住四类最容易写坏的事：
 *   1. **资格口径**：草稿 / 待审 / 被驳回 / 已撤回的测评都不算数，只有真正挂出去的才算（§4.1）；
 *      插件同理，pending 与 rejected 的认领不算（§4.2）。
 *   2. **状态机与冷却期**：pending 不能重复申请；被驳回后进冷却；撤回**没有**冷却（§3.2）。
 *   3. **撤销只打标记**：撤销身份不动该用户的评测与插件（§11 明确留白，不许擅自连带下线）。
 *   4. **权限隔离**：非管理员不能审核、不能撤销；user_roles 不改变 users.role。
 *
 * 还有一条跨 PR 边界的：本分支上 forum 表可能不存在，`listMyRoles` 必须返回空数组而不是抛
 * no such table。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertUser,
  insertRepository,
  insertPlugin,
  insertReview,
  insertReviewRevision,
} from './support/db';
import type { TestDb } from './support/db';
import { createRoleService, type RoleService } from '../src/server/modules/roles/service';
import type { CallerContext } from '@/server/platform/context';
import { DAY } from '@/server/platform/time';
import { ErrorCodes, DomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

/** 从库里读调用上下文：角色每次从库读，与真实请求一致。 */
function caller(db: TestDb['db'], userId: string | null): CallerContext {
  if (userId === null) return { userId: null, role: 'user', accountStatus: 'active' };
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

/** 断言某次调用抛出指定错误码（其余情况让测试红，而不是悄悄通过）。 */
async function expectCode(fn: () => Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    const de = e as DomainError;
    expect(de.code).toBe(code);
    return de;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
}

interface Fixture {
  db: TestDb['db'];
  service: RoleService;
  admin: string;
  alice: string;
  bob: string;
}

function setup(): Fixture {
  ctx = createTestDb();
  const db = ctx.db;
  return {
    db,
    service: createRoleService({ db }),
    admin: insertUser(db, { role: 'admin', nickname: '管理员' }),
    alice: insertUser(db, { nickname: '爱丽丝' }),
    bob: insertUser(db, { nickname: '鲍勃' }),
  };
}

/**
 * 造一篇指定状态的测评。
 *
 * 口径全部落在**真实列**上，不加任何假字段：
 *   published → reviews.published_revision_id 有值
 *   draft     → 两个 revision 指针都为空（从没提交过）
 *   pending   → 只填 latest_submitted_revision_id（已提交、未发布，等价于待审/待处理）
 *   withdrawn / hidden → 有发布修订，但内容实体的 withdrawn_at / hidden_at 非空
 */
function addReview(
  db: TestDb['db'],
  authorId: string,
  state: 'published' | 'draft' | 'pending' | 'withdrawn' | 'hidden',
): string {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo);
  const reviewId = insertReview(db, { authorId, pluginId: plugin });
  const revisionId = insertReviewRevision(db, { reviewId, pluginId: plugin, revisionNumber: 1 });

  if (state !== 'draft') {
    db.prepare('UPDATE reviews SET latest_submitted_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
  }
  if (state === 'published' || state === 'withdrawn' || state === 'hidden') {
    db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
  }
  if (state === 'withdrawn') {
    // 库里有触发器守着：可见性字段变动必须同时递增 visibility_control_version。
    db.prepare(
      'UPDATE content_entities SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1 WHERE id = ?',
    ).run(Date.now(), '作者撤回', reviewId);
  }
  if (state === 'hidden') {
    db.prepare(
      'UPDATE content_entities SET hidden_at = ?, hidden_by = ?, hidden_reason = ?, visibility_control_version = visibility_control_version + 1 WHERE id = ?',
    ).run(Date.now(), authorId, '违规', reviewId);
  }
  return reviewId;
}

/** 造一个指定状态的插件归属。 */
function addOwnership(db: TestDb['db'], userId: string, status: 'pending' | 'verified' | 'rejected') {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo);
  db.prepare(
    `INSERT INTO plugin_ownerships
       (id, plugin_id, user_id, source, status, claimed_note, reviewer_id, reviewed_at, created_at)
     VALUES (?, ?, ?, 'claimed', ?, NULL, NULL, ?, ?)`,
  ).run(
    'own_' + Math.random().toString(16).slice(2),
    plugin,
    userId,
    status,
    status === 'pending' ? null : Date.now(),
    Date.now(),
  );
}

/** 把一次驳回的 reviewed_at 往前挪，模拟「冷却期已过」。 */
function ageReview(db: TestDb['db'], applicationId: string, days: number) {
  db.prepare('UPDATE role_applications SET reviewed_at = reviewed_at - ? WHERE id = ?').run(days * DAY, applicationId);
}

// ============================================================
// 资格判定（设计 §4）
// ============================================================

describe('测评员资格：只认已发布的测评', () => {
  it('一篇已发布的测评就够', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    const r = await service.checkReviewerEligibility(alice);
    expect(r.eligible).toBe(true);
    expect(r.count).toBe(1);
    expect(r.reason).toBeNull();
    expect(r.evidence).toEqual({ reviewCount: 1 });
  });

  it('草稿不算', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'draft');
    const r = await service.checkReviewerEligibility(alice);
    expect(r.eligible).toBe(false);
    expect(r.count).toBe(0);
    expect(r.reason).toContain('已发布');
  });

  it('已提交但未发布（待审）不算', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'pending');
    expect((await service.checkReviewerEligibility(alice)).count).toBe(0);
  });

  it('只有提交、没有发布修订的（被驳回 / 待处理）不算', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'pending');
    expect((await service.checkReviewerEligibility(alice)).count).toBe(0);
  });

  it('已撤回 / 已隐藏都不算', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'withdrawn');
    addReview(db, alice, 'hidden');
    expect((await service.checkReviewerEligibility(alice)).count).toBe(0);
  });

  it('混着放时只数已发布的那几篇，且不串到别人名下', async () => {
    const { db, service, alice, bob } = setup();
    addReview(db, alice, 'published');
    addReview(db, alice, 'published');
    addReview(db, alice, 'draft');
    addReview(db, alice, 'withdrawn');
    addReview(db, bob, 'published');
    expect((await service.checkReviewerEligibility(alice)).count).toBe(2);
    expect((await service.checkReviewerEligibility(bob)).count).toBe(1);
  });
});

describe('开发者资格：只认已验证归属的插件', () => {
  it('0 个插件不合格', async () => {
    const { service, alice } = setup();
    const r = await service.checkDeveloperEligibility(alice);
    expect(r.eligible).toBe(false);
    expect(r.count).toBe(0);
    expect(r.evidence).toEqual({ verifiedPluginCount: 0 });
  });

  it('1 个 verified 就够了', async () => {
    const { db, service, alice } = setup();
    addOwnership(db, alice, 'verified');
    const r = await service.checkDeveloperEligibility(alice);
    expect(r.eligible).toBe(true);
    expect(r.count).toBe(1);
  });

  it('pending 与 rejected 的认领都不算', async () => {
    const { db, service, alice } = setup();
    addOwnership(db, alice, 'pending');
    addOwnership(db, alice, 'rejected');
    expect((await service.checkDeveloperEligibility(alice)).count).toBe(0);
  });
});

describe('checkEligibility 分派', () => {
  it('按身份类型分派到对应口径；不认识的类型抛输入错误', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    expect((await service.checkEligibility('reviewer', alice)).eligible).toBe(true);
    expect((await service.checkEligibility('developer', alice)).eligible).toBe(false);
    await expectCode(() => service.checkEligibility('ceo' as never, alice), ErrorCodes.INPUT_INVALID);
  });
});

// ============================================================
// 申请（§3.2 状态机）
// ============================================================

describe('提交申请', () => {
  it('资格不足被拒，并说清缺什么', async () => {
    const { db, service, alice } = setup();
    const e = await expectCode(() => service.applyForRole(caller(db, alice), 'reviewer'), ErrorCodes.INPUT_INVALID);
    expect(e.message).toContain('已发布');
    const n = (db.prepare('SELECT COUNT(*) AS c FROM role_applications').get() as { c: number }).c;
    expect(n).toBe(0);
  });

  it('资格够时落 pending，并把资格快照写进 evidence', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer', '  我想写测评  ');
    expect(app.status).toBe('pending');
    expect(app.roleType).toBe('reviewer');
    expect(app.note).toBe('我想写测评');
    expect(app.evidence).toEqual({ reviewCount: 2 });

    const row = db
      .prepare('SELECT status, evidence, reviewer_id, reviewed_at FROM role_applications WHERE id = ?')
      .get(app.id) as { status: string; evidence: string; reviewer_id: string | null; reviewed_at: number | null };
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.evidence)).toEqual({ reviewCount: 2 });
    expect(row.reviewer_id).toBeNull();
    expect(row.reviewed_at).toBeNull();
  });

  it('开发者的申请快照记的是已验证插件数', async () => {
    const { db, service, alice } = setup();
    addOwnership(db, alice, 'verified');
    const app = await service.applyForRole(caller(db, alice), 'developer');
    expect(app.evidence).toEqual({ verifiedPluginCount: 1 });
  });

  it('重复申请被拒（已有 pending）', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    await service.applyForRole(caller(db, alice), 'reviewer');
    await expectCode(() => service.applyForRole(caller(db, alice), 'reviewer'), ErrorCodes.VERSION_CONFLICT);
  });

  it('已是该身份的人不能再申请', async () => {
    const { db, service, admin, alice } = setup();
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    db.prepare(
      `INSERT INTO user_roles (id, user_id, role_type, status, granted_by, granted_at)
       VALUES (?, ?, 'reviewer', 'active', ?, ?)`,
    ).run('role_' + Math.random().toString(16).slice(2), alice, admin, Date.now());
    void plugin;
    addReview(db, alice, 'published');
    await expectCode(() => service.applyForRole(caller(db, alice), 'reviewer'), ErrorCodes.VERSION_CONFLICT);
  });

  it('未登录 / 账户禁用不能申请', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    await expectCode(() => service.applyForRole(caller(db, null), 'reviewer'), ErrorCodes.UNAUTHENTICATED);
    db.prepare("UPDATE users SET account_status = 'disabled' WHERE id = ?").run(alice);
    await expectCode(() => service.applyForRole(caller(db, alice), 'reviewer'), ErrorCodes.ACCOUNT_DISABLED);
  });

  it('自述超 500 字被拒（与库里 CHECK 一致，先给人话）', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    await expectCode(
      () => service.applyForRole(caller(db, alice), 'reviewer', 'x'.repeat(501)),
      ErrorCodes.INPUT_INVALID,
    );
  });
});

// ============================================================
// 审核（管理员）
// ============================================================

describe('审核申请', () => {
  it('通过后 user_roles 有一条 active 记录，带授予人与来源申请', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    const reviewed = await service.reviewApplication(caller(db, admin), app.id, 'approve', null);
    expect(reviewed.status).toBe('approved');
    expect(reviewed.reviewerId).toBe(admin);
    expect(reviewed.reviewedAt).not.toBeNull();

    const role = db
      .prepare('SELECT status, granted_by, application_id, granted_at, revoked_at FROM user_roles WHERE user_id = ?')
      .get(alice) as { status: string; granted_by: string; application_id: string; granted_at: number; revoked_at: number | null };
    expect(role.status).toBe('active');
    expect(role.granted_by).toBe(admin);
    expect(role.application_id).toBe(app.id);
    expect(role.revoked_at).toBeNull();
    expect(await service.hasRole(caller(db, alice), 'reviewer')).toBe(true);
    expect(await service.listActiveRoles(alice)).toEqual(['reviewer']);
  });

  it('通过后 users.role 原样不动（身份叠加不改变权限底座）', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(alice) as { role: string };
    expect(row.role).toBe('user');
    expect(service.isBaseAdmin(alice)).toBe('user');
  });

  it('驳回后记录 rejected 且冷却期生效', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    const reviewed = await service.reviewApplication(caller(db, admin), app.id, 'reject', '请再多写两篇');
    expect(reviewed.status).toBe('rejected');
    expect(reviewed.reviewNote).toBe('请再多写两篇');
    // 驳回不产生身份
    expect((db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number }).c).toBe(0);
    expect(await service.hasRole(caller(db, alice), 'reviewer')).toBe(false);

    const e = await expectCode(
      () => service.applyForRole(caller(db, alice), 'reviewer'),
      ErrorCodes.RATE_LIMITED,
    );
    expect(e.context?.retryAfterDays).toBe(30);
    expect(e.message).toContain('30 天');
  });

  it('冷却期过了可以再申请，并复用同一次通过后的那一行 user_roles', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const first = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), first.id, 'reject', '不够');
    ageReview(db, first.id, 31);
    const second = await service.applyForRole(caller(db, alice), 'reviewer');
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
  });

  it('冷却天数读设置项：调成 0 就没有冷却', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    // site_settings.changed_in_revision_id 是 NOT NULL（每行都必须指向是哪次修改改的），
    // 所以先落一条修订再写配置，别为了省事绕过约束。
    const now = Date.now();
    db.prepare(
      `INSERT INTO configuration_revisions
         (id, revision_number, definition_version, effective_snapshot, changes, reason, changed_by, created_at)
       VALUES ('rev-test-1', 1, 1, '{}', '{}', '测试', ?, ?)`,
    ).run(admin, now);
    db.prepare(
      `INSERT INTO site_settings (key, value, changed_in_revision_id, updated_by, updated_at)
       VALUES ('roles.application_cooldown_days', '0', 'rev-test-1', ?, ?)`,
    ).run(admin, now);
    const first = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), first.id, 'reject', '不够');
    const second = await service.applyForRole(caller(db, alice), 'reviewer');
    expect(second.status).toBe('pending');
  });

  it('已经处理过的申请不能再审一次', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);
    await expectCode(
      () => service.reviewApplication(caller(db, admin), app.id, 'reject', '改主意了'),
      ErrorCodes.VERSION_CONFLICT,
    );
  });

  it('不存在的申请报不可访问', async () => {
    const { db, service, admin } = setup();
    await expectCode(
      () => service.reviewApplication(caller(db, admin), 'no-such-id', 'approve', null),
      ErrorCodes.TARGET_UNAVAILABLE,
    );
  });
});

// ============================================================
// 撤回（§3.2：撤回后无冷却）
// ============================================================

describe('撤回申请', () => {
  it('pending 可撤；撤后不写审核痕迹', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    const withdrawn = await service.withdrawApplication(caller(db, alice), app.id);
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.reviewerId).toBeNull();
    expect(withdrawn.reviewedAt).toBeNull();
  });

  it('撤回后没有冷却期，可以立刻再申请', async () => {
    const { db, service, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.withdrawApplication(caller(db, alice), app.id);
    const again = await service.applyForRole(caller(db, alice), 'reviewer');
    expect(again.status).toBe('pending');
  });

  it('已通过 / 已驳回 / 已撤回的申请不能撤', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'reject', '不够');
    await expectCode(() => service.withdrawApplication(caller(db, alice), app.id), ErrorCodes.VERSION_CONFLICT);
  });

  it('别人的申请撤不动（按不存在处理，不泄露存在性）', async () => {
    const { db, service, alice, bob } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await expectCode(() => service.withdrawApplication(caller(db, bob), app.id), ErrorCodes.TARGET_UNAVAILABLE);
    const row = db.prepare('SELECT status FROM role_applications WHERE id = ?').get(app.id) as { status: string };
    expect(row.status).toBe('pending');
  });
});

// ============================================================
// 撤销（§11：只打标记，不动内容）
// ============================================================

describe('撤销身份', () => {
  it('撤销后 status=revoked 并留下操作人与时刻', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);

    const revoked = await service.revokeRole(caller(db, admin), alice, 'reviewer', '资格已失效');
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).not.toBeNull();
    expect(await service.hasRole(caller(db, alice), 'reviewer')).toBe(false);
    expect(await service.listActiveRoles(alice)).toEqual([]);

    const row = db
      .prepare('SELECT status, revoked_by, revoked_at FROM user_roles WHERE user_id = ?')
      .get(alice) as { status: string; revoked_by: string; revoked_at: number };
    expect(row.status).toBe('revoked');
    expect(row.revoked_by).toBe(admin);
    expect(row.revoked_at).toBeGreaterThan(0);
  });

  it('撤销不动该用户的评测与插件（§11 明确留白，不许擅自连带下线）', async () => {
    const { db, service, admin, alice } = setup();
    const reviewId = addReview(db, alice, 'published');
    addOwnership(db, alice, 'verified');

    const reviewBefore = db
      .prepare('SELECT published_revision_id, latest_submitted_revision_id FROM reviews WHERE id = ?')
      .get(reviewId) as { published_revision_id: string; latest_submitted_revision_id: string };
    const ceBefore = db
      .prepare('SELECT withdrawn_at, hidden_at, visibility_control_version FROM content_entities WHERE id = ?')
      .get(reviewId) as { withdrawn_at: number | null; hidden_at: number | null; visibility_control_version: number };
    const ownBefore = db
      .prepare('SELECT status FROM plugin_ownerships WHERE user_id = ?')
      .get(alice) as { status: string };

    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);
    await service.revokeRole(caller(db, admin), alice, 'reviewer', '资格已失效');

    const reviewAfter = db
      .prepare('SELECT published_revision_id, latest_submitted_revision_id FROM reviews WHERE id = ?')
      .get(reviewId) as { published_revision_id: string; latest_submitted_revision_id: string };
    const ceAfter = db
      .prepare('SELECT withdrawn_at, hidden_at, visibility_control_version FROM content_entities WHERE id = ?')
      .get(reviewId) as { withdrawn_at: number | null; hidden_at: number | null; visibility_control_version: number };
    const ownAfter = db
      .prepare('SELECT status FROM plugin_ownerships WHERE user_id = ?')
      .get(alice) as { status: string };

    expect(reviewAfter).toEqual(reviewBefore);
    expect(ceAfter).toEqual(ceBefore);
    expect(ownAfter).toEqual(ownBefore);
    // 撤销身份不该让他的评测变得「不合格」：资格判定看的是内容，不是身份。
    expect((await service.checkReviewerEligibility(alice)).eligible).toBe(true);
  });

  it('撤销后可以重新申请，通过后复用同一行 user_roles 并清掉撤销痕迹', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const first = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), first.id, 'approve', null);
    await service.revokeRole(caller(db, admin), alice, 'reviewer', '失效');

    const second = await service.applyForRole(caller(db, alice), 'reviewer');
    expect(second.status).toBe('pending');
    await service.reviewApplication(caller(db, admin), second.id, 'approve', null);

    const rows = db
      .prepare('SELECT status, revoked_by, revoked_at, application_id FROM user_roles WHERE user_id = ?')
      .all(alice) as Array<{ status: string; revoked_by: string | null; revoked_at: number | null; application_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.revoked_by).toBeNull();
    expect(rows[0]?.revoked_at).toBeNull();
    expect(rows[0]?.application_id).toBe(second.id);
  });

  it('没有该身份 / 已撤销过都报错', async () => {
    const { db, service, admin, alice } = setup();
    await expectCode(
      () => service.revokeRole(caller(db, admin), alice, 'reviewer', null),
      ErrorCodes.TARGET_UNAVAILABLE,
    );

    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);
    await service.revokeRole(caller(db, admin), alice, 'reviewer', null);
    await expectCode(
      () => service.revokeRole(caller(db, admin), alice, 'reviewer', null),
      ErrorCodes.VERSION_CONFLICT,
    );
  });
});

// ============================================================
// 多身份并存（R3：一个一个申请，互不影响）
// ============================================================

describe('多身份', () => {
  it('同一用户同时持有 reviewer 与 developer，撤销其一不影响另一个', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    addOwnership(db, alice, 'verified');

    const rApp = await service.applyForRole(caller(db, alice), 'reviewer');
    const dApp = await service.applyForRole(caller(db, alice), 'developer');
    await service.reviewApplication(caller(db, admin), rApp.id, 'approve', null);
    await service.reviewApplication(caller(db, admin), dApp.id, 'approve', null);

    expect((await service.listActiveRoles(alice)).sort()).toEqual(['developer', 'reviewer']);

    await service.revokeRole(caller(db, admin), alice, 'reviewer', '收回测评员');
    expect(await service.listActiveRoles(alice)).toEqual(['developer']);
    expect(await service.hasRole(caller(db, alice), 'developer')).toBe(true);
    expect(await service.hasRole(caller(db, alice), 'reviewer')).toBe(false);
  });

  it('一个身份的 pending 不影响另一个身份的申请与审核', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    addOwnership(db, alice, 'verified');

    await service.applyForRole(caller(db, alice), 'reviewer');
    const dApp = await service.applyForRole(caller(db, alice), 'developer');
    await service.reviewApplication(caller(db, admin), dApp.id, 'approve', null);
    expect(await service.listActiveRoles(alice)).toEqual(['developer']);

    const queue = await service.listApplicationsForAdmin(caller(db, admin), 'pending');
    expect(queue).toHaveLength(1);
    expect(queue[0]?.roleType).toBe('reviewer');
  });
});

// ============================================================
// 权限隔离
// ============================================================

describe('权限：非管理员不能审核、不能撤销', () => {
  it('普通用户审核被拒（forbidden），申请状态不变', async () => {
    const { db, service, alice, bob } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await expectCode(() => service.reviewApplication(caller(db, bob), app.id, 'approve', null), ErrorCodes.FORBIDDEN);
    const row = db.prepare('SELECT status FROM role_applications WHERE id = ?').get(app.id) as { status: string };
    expect(row.status).toBe('pending');
    expect((db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number }).c).toBe(0);
  });

  it('普通用户撤销被拒', async () => {
    const { db, service, admin, alice, bob } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);
    await expectCode(
      () => service.revokeRole(caller(db, bob), alice, 'reviewer', '我说了算'),
      ErrorCodes.FORBIDDEN,
    );
    expect(await service.hasRole(caller(db, alice), 'reviewer')).toBe(true);
  });

  it('账户被禁用的管理员也不能审核', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    db.prepare("UPDATE users SET account_status = 'disabled' WHERE id = ?").run(admin);
    await expectCode(() => service.reviewApplication(caller(db, admin), app.id, 'approve', null), ErrorCodes.FORBIDDEN);
  });

  it('匿名不能看队列', async () => {
    const { db, service } = setup();
    await expectCode(() => service.listApplicationsForAdmin(caller(db, null), 'pending'), ErrorCodes.FORBIDDEN);
    await expectCode(() => service.listMyRoles(caller(db, null)), ErrorCodes.UNAUTHENTICATED);
  });
});

// ============================================================
// 「我的身份」
// ============================================================

describe('我的身份', () => {
  it('原样带出底座角色 + 已持有身份 + 两个可申请身份的资格', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'approve', null);

    const mine = await service.listMyRoles(caller(db, alice));
    expect(mine.userId).toBe(alice);
    expect(mine.baseRole).toBe('user');
    expect(mine.roles).toHaveLength(1);
    expect(mine.roles[0]).toMatchObject({ roleType: 'reviewer', status: 'active', applicationId: app.id });

    const reviewer = mine.applications.find((a) => a.roleType === 'reviewer');
    const developer = mine.applications.find((a) => a.roleType === 'developer');
    expect(reviewer?.held).toBe(true);
    expect(reviewer?.count).toBe(1);
    expect(reviewer?.pendingApplicationId).toBeNull();
    expect(developer?.held).toBe(false);
    expect(developer?.eligible).toBe(false);
    expect(developer?.reason).toBeTruthy();

    expect(mine.history).toHaveLength(1);
    expect(mine.history[0]?.status).toBe('approved');
  });

  it('驳回后给出冷却截止与最近驳回单号', async () => {
    const { db, service, admin, alice } = setup();
    addReview(db, alice, 'published');
    const app = await service.applyForRole(caller(db, alice), 'reviewer');
    await service.reviewApplication(caller(db, admin), app.id, 'reject', '不够');

    const mine = await service.listMyRoles(caller(db, alice));
    const reviewer = mine.applications.find((a) => a.roleType === 'reviewer');
    expect(reviewer?.lastRejectedApplicationId).toBe(app.id);
    expect(reviewer?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('没有 forum 表时不抛错，区长汇总返回空数组', async () => {
    const { db, service, alice } = setup();
    // 本分支上 forum 表属于另一个 PR，可能压根不存在；先确认确实没有。
    const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'forum_board_moderators'").get();
    expect(has).toBeUndefined();

    const mine = await service.listMyRoles(caller(db, alice));
    expect(mine.boardModerators).toEqual([]);
  });

  it('forum 表存在但板块表缺失时也不抛错（只回退展示字段）', async () => {
    const { db, service, alice } = setup();
    db.exec('CREATE TABLE forum_board_moderators (board_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL)');
    db.prepare('INSERT INTO forum_board_moderators (board_id, user_id, role) VALUES (?, ?, ?)').run('board-1', alice, 'owner');

    const mine = await service.listMyRoles(caller(db, alice));
    expect(mine.boardModerators).toHaveLength(1);
    // 没有板块表就拿不到名字，回退成 id，而不是给一个空标题。
    expect(mine.boardModerators[0]).toEqual({ boardId: 'board-1', boardSlug: null, boardName: 'board-1', role: 'owner' });

    // 关键：区长身份**不**进 user_roles（设计 §3.4）。
    expect(mine.roles).toEqual([]);
  });
});

// ============================================================
// 后台队列
// ============================================================

describe('审核队列', () => {
  it('按状态筛，带申请人昵称与资格快照', async () => {
    const { db, service, admin, alice, bob } = setup();
    addReview(db, alice, 'published');
    addReview(db, bob, 'published');
    addReview(db, bob, 'published');
    const a1 = await service.applyForRole(caller(db, alice), 'reviewer', '我是爱丽丝');
    await service.applyForRole(caller(db, bob), 'reviewer', '我是鲍勃');
    await service.reviewApplication(caller(db, admin), a1.id, 'approve', null);

    const pending = await service.listApplicationsForAdmin(caller(db, admin), 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.userNickname).toBe('鲍勃');
    expect(pending[0]?.evidence).toEqual({ reviewCount: 2 });

    const approved = await service.listApplicationsForAdmin(caller(db, admin), 'approved');
    expect(approved.map((r) => r.id)).toEqual([a1.id]);

    const all = await service.listApplicationsForAdmin(caller(db, admin), 'all');
    expect(all).toHaveLength(2);
  });

  it('不认识的 status 抛输入错误', async () => {
    const { db, service, admin } = setup();
    // listApplicationsForAdmin 是 async 方法：入参校验失败会变成 rejected promise，
    // 所以这里必须 await expectCode，不能用同步的 expectCodeSync（那个会把 rejection 漏成 unhandled）。
    await expectCode(
      () => service.listApplicationsForAdmin(caller(db, admin), 'whatever' as never),
      ErrorCodes.INPUT_INVALID,
    );
  });
});

// ============================================================
// 库级兜底
// ============================================================

describe('库级兜底（服务层的检查之外，库自己也守住）', () => {
  it('同一用户同一身份同时只能有一条 pending（部分唯一索引）', async () => {
    const { db, alice } = setup();
    const insert = (id: string) =>
      db
        .prepare(
          `INSERT INTO role_applications (id, user_id, role_type, status, created_at)
           VALUES (?, ?, 'reviewer', 'pending', ?)`,
        )
        .run(id, alice, Date.now());
    insert('app-1');
    expect(() => insert('app-2')).toThrow(/UNIQUE/i);
  });

  it('撤销态必须带撤销人与时刻（成对约束不会被绕过）', async () => {
    const { db, admin, alice } = setup();
    expect(() =>
      db
        .prepare(
          `INSERT INTO user_roles (id, user_id, role_type, status, granted_by, granted_at)
           VALUES ('r-bad', ?, 'reviewer', 'revoked', ?, ?)`,
        )
        .run(alice, admin, Date.now()),
    ).toThrow(/CHECK/i);
  });
});

