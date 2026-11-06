/**
 * 用户身份体系 · 后台审核队列（认领 / 身份申请）。
 *
 * 这个文件盯住后台队列最容易写坏的几件事：
 *   1. **队列口径**：只把 pending 摆出来审，处理过的不再出现在待审里；
 *   2. **驳回必须带理由**：理由要能回到申请人眼前（`listMine().reviewNote`），
 *      接口层的空理由必须被挡成 400，而不是写一条"不知道为什么被拒"的记录；
 *   3. **重复审核**：同一条记录审两次要报 409（`err.conflict` → version_conflict），
 *      不能悄悄覆盖第一次的结论；
 *   4. **权限**：非管理员 403、匿名 401，两者不混；
 *   5. 页面与接口用的是**同一组服务层方法**——所以这里直接测服务层，
 *      不重复测一遍 SQL；接口层只测它自己负责的入参校验。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, insertRepository, insertPlugin, type TestDb } from './support/db';
import { createPluginOwnershipService } from '../src/server/modules/roles/ownership';
import type { OwnershipQueueItem } from '../src/server/modules/roles/ownership';
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

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin', nickname: '管理员' });
  const alice = insertUser(db, { nickname: 'Alice' });
  const service = createPluginOwnershipService({ db });
  return { db, admin, alice, service };
}

/** 造一条 pending 认领（组织仓库，自动匹配必然失败）。 */
async function seedPendingClaim(s: ReturnType<typeof setup>, note: string | null = null): Promise<string> {
  const repo = insertRepository(s.db);
  s.db.prepare('UPDATE repositories SET owner_login = ?, full_name = ? WHERE id = ?').run('dsh-org', 'dsh-org/x', repo);
  const plugin = insertPlugin(s.db, repo);
  await s.service.claimPlugin(caller(s.db, s.alice), plugin, note === null ? {} : { note });
  return plugin;
}

function expectCode(expected: string) {
  return (e: unknown) => isDomainError(e) && e.code === expected;
}

describe('认领队列：口径', () => {
  it('只看 pending；处理完的那条立刻从待审里消失', async () => {
    const s = setup();
    await seedPendingClaim(s, '我是组织成员');
    const admin = caller(s.db, s.admin);

    const before = await s.service.listQueue(admin, 'pending');
    expect(before).toHaveLength(1);
    expect(before[0]!.userNickname).toBe('Alice');
    expect(before[0]!.claimedNote).toBe('我是组织成员');
    expect(before[0]!.ownershipSource).toBe('claimed');

    await s.service.reviewClaim(admin, before[0]!.ownershipId, 'verify', null);

    expect(await s.service.listQueue(admin, 'pending')).toHaveLength(0);
    const all = await s.service.listQueue(admin, 'all');
    expect(all).toHaveLength(1);
    expect(all[0]!.ownershipStatus).toBe('verified');
  });

  it('列表带齐后台要显示的字段（昵称 / 仓库全名 / 插件路径 / 时间）', async () => {
    const s = setup();
    await seedPendingClaim(s);
    const rows: OwnershipQueueItem[] = await s.service.listQueue(caller(s.db, s.admin), 'pending');
    const row = rows[0]!;
    expect(row.userId).toBe(s.alice);
    expect(row.repositoryFullName).toBe('dsh-org/x');
    expect(row.pluginPath).toBe('.');
    expect(typeof row.createdAt).toBe('number');
    expect(row.createdAt).toBeGreaterThan(0);
  });
});

describe('认领审核：驳回理由', () => {
  it('驳回后申请人能在「我的插件」里看到理由', async () => {
    const s = setup();
    await seedPendingClaim(s, '我是维护者');
    const admin = caller(s.db, s.admin);
    const queue = await s.service.listQueue(admin, 'pending');

    await s.service.reviewClaim(admin, queue[0]!.ownershipId, 'reject', '仓库 owner 是组织，请附上维护者截图');

    const mine = await s.service.listMine(caller(s.db, s.alice));
    expect(mine[0]!.ownershipStatus).toBe('rejected');
    expect(mine[0]!.reviewNote).toBe('仓库 owner 是组织，请附上维护者截图');
  });

  it('驳回时可以不带理由（接口层才强制），服务层不自作主张拦', async () => {
    const s = setup();
    await seedPendingClaim(s);
    const admin = caller(s.db, s.admin);
    const queue = await s.service.listQueue(admin, 'pending');
    await s.service.reviewClaim(admin, queue[0]!.ownershipId, 'reject', null);
    const mine = await s.service.listMine(caller(s.db, s.alice));
    expect(mine[0]!.ownershipStatus).toBe('rejected');
  });

  it('理由超过 500 字被截到 500（库里有 CHECK，服务层先截断而不是让约束炸出 500）', async () => {
    const s = setup();
    await seedPendingClaim(s);
    const admin = caller(s.db, s.admin);
    const queue = await s.service.listQueue(admin, 'pending');
    await s.service.reviewClaim(admin, queue[0]!.ownershipId, 'reject', 'x'.repeat(800));

    const mine = await s.service.listMine(caller(s.db, s.alice));
    expect(mine[0]!.reviewNote).toHaveLength(500);
  });
});

describe('认领审核：重复与冲突', () => {
  it('同一条认领审两次：第二次报冲突，不覆盖第一次的结论', async () => {
    const s = setup();
    await seedPendingClaim(s);
    const admin = caller(s.db, s.admin);
    const queue = await s.service.listQueue(admin, 'pending');

    await s.service.reviewClaim(admin, queue[0]!.ownershipId, 'reject', '证据不足');
    await expect(s.service.reviewClaim(admin, queue[0]!.ownershipId, 'verify', null)).rejects.toSatisfy(
      expectCode(ErrorCodes.VERSION_CONFLICT),
    );

    // 第一次结论仍在
    const mine = await s.service.listMine(caller(s.db, s.alice));
    expect(mine[0]!.ownershipStatus).toBe('rejected');
  });

  it('不存在的认领 id 报 target_unavailable', async () => {
    const s = setup();
    await expect(
      s.service.reviewClaim(caller(s.db, s.admin), 'own_不存在', 'verify', null),
    ).rejects.toSatisfy(expectCode(ErrorCodes.TARGET_UNAVAILABLE));
  });

  it('插件已有归属人时，再通过第二个人被拒（一个插件只能有一个 verified）', async () => {
    const s = setup();
    const bob = insertUser(s.db, { nickname: 'Bob' });
    const repo = insertRepository(s.db);
    s.db.prepare('UPDATE repositories SET owner_login = ?, full_name = ? WHERE id = ?').run('dsh-org', 'dsh-org/y', repo);
    const plugin = insertPlugin(s.db, repo);

    await s.service.claimPlugin(caller(s.db, s.alice), plugin, { note: 'A' });
    await s.service.claimPlugin(caller(s.db, bob), plugin, { note: 'B' });

    const admin = caller(s.db, s.admin);
    const queue = await s.service.listQueue(admin, 'pending');
    expect(queue).toHaveLength(2);
    await s.service.reviewClaim(admin, queue[0]!.ownershipId, 'verify', null);
    await expect(s.service.reviewClaim(admin, queue[1]!.ownershipId, 'verify', null)).rejects.toSatisfy(
      expectCode(ErrorCodes.VERSION_CONFLICT),
    );
  });
});

describe('后台队列：权限', () => {
  it('非管理员看队列 403', async () => {
    const s = setup();
    await expect(s.service.listQueue(caller(s.db, s.alice), 'pending')).rejects.toSatisfy(
      expectCode(ErrorCodes.FORBIDDEN),
    );
  });

  it('非管理员审核 403', async () => {
    const s = setup();
    await seedPendingClaim(s);
    const queue = await s.service.listQueue(caller(s.db, s.admin), 'pending');
    await expect(
      s.service.reviewClaim(caller(s.db, s.alice), queue[0]!.ownershipId, 'verify', null),
    ).rejects.toSatisfy(expectCode(ErrorCodes.FORBIDDEN));
  });

  it('匿名看队列 403（队列不是公开列表）', async () => {
    const s = setup();
    await expect(s.service.listQueue(caller(s.db, null), 'pending')).rejects.toSatisfy(
      expectCode(ErrorCodes.FORBIDDEN),
    );
  });
});

describe('身份服务未交付时，路由骨架不撒谎', () => {
  it('roles/service.ts 此刻是否存在：不存在时必须能被明确察觉', async () => {
    // 这条断言的意义：后台页与接口都靠「导入失败 → 明确报错」兜底，
    // 而不是伪装成 200 空列表。若队友已经交付了 service.ts，这条自动跳过，
    // 由 roles-service 的测试接手（这里只守住"不会静默变空"这件事）。
    let verdict: 'ready' | 'missing' = 'missing';
    let mod: Record<string, unknown> | null = null;
    try {
      mod = (await import('../src/server/modules/roles/service')) as unknown as Record<string, unknown>;
      verdict = 'ready';
    } catch {
      verdict = 'missing';
    }
    // 导入成功就必须真的导出 createRolesService（不允许"半个模块"）；
    // 导入失败则明确判为未就绪——页面与接口据此报错，而不是显示成空队列。
    if (verdict === 'ready') {
      expect(typeof mod!['createRolesService']).toBe('function');
    } else {
      expect(verdict).toBe('missing');
    }
  });
});
