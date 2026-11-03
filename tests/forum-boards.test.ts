/**
 * 讨论区 · 分区与权限（迁移 0037）。
 *
 * 重点测三件容易写错的事：
 *   1. 发帖判定的优先级（黑名单必须盖过白名单）；
 *   2. 分区权限只在本区生效，不泄漏成全局权限；
 *   3. owner 不能被协管罢免（D6）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import {
  createForumBoardService,
  decidePosting,
  ensureDefaultBoards,
} from '../src/server/modules/forum/boards';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

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
  ensureDefaultBoards(db);
  return { db, admin, alice, bob, service: createForumBoardService({ db }) };
}

function boardIdBySlug(db: TestDb['db'], slug: string): string {
  const row = db.prepare('SELECT id FROM forum_boards WHERE slug = ?').get(slug) as { id: string };
  return row.id;
}

describe('decidePosting：纯判定', () => {
  const base = { boardStatus: 'active' as const, admin: false, boardRole: null, rule: null };

  it('everyone：默认放行', () => {
    expect(decidePosting({ ...base, policy: 'everyone' }).allowed).toBe(true);
  });

  it('黑名单盖过白名单：被踢的人不能靠 allow 名单回来', () => {
    expect(decidePosting({ ...base, policy: 'everyone', rule: 'deny' }).allowed).toBe(false);
    expect(decidePosting({ ...base, policy: 'whitelist', rule: 'deny' }).allowed).toBe(false);
  });

  it('whitelist：不在名单拒绝，在名单放行', () => {
    expect(decidePosting({ ...base, policy: 'whitelist' }).allowed).toBe(false);
    expect(decidePosting({ ...base, policy: 'whitelist', rule: 'allow' }).allowed).toBe(true);
  });

  it('admin_only：普通用户拒绝，站方管理员放行', () => {
    expect(decidePosting({ ...base, policy: 'admin_only' }).allowed).toBe(false);
    expect(decidePosting({ ...base, policy: 'admin_only', admin: true }).allowed).toBe(true);
  });

  it('分区 owner 始终可发（含 admin_only 之外的策略）', () => {
    expect(decidePosting({ ...base, policy: 'whitelist', boardRole: 'owner' }).allowed).toBe(true);
  });

  it('归档分区一律不可发，连管理员也不行', () => {
    const r = decidePosting({ ...base, policy: 'everyone', boardStatus: 'archived', admin: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('归档');
  });
});

describe('默认分区', () => {
  it('自动创建官方公告区与综合讨论区，且幂等', () => {
    const { db } = setup();
    const rows = db.prepare('SELECT slug, posting_policy, is_official FROM forum_boards ORDER BY slug').all() as Array<{
      slug: string;
      posting_policy: string;
      is_official: number;
    }>;
    expect(rows).toHaveLength(2);
    const announcements = rows.find((r) => r.slug === 'announcements');
    expect(announcements?.posting_policy).toBe('admin_only');
    expect(announcements?.is_official).toBe(1);

    ensureDefaultBoards(db); // 再来一次
    const count = db.prepare('SELECT COUNT(*) AS c FROM forum_boards').get() as { c: number };
    expect(Number(count.c)).toBe(2);
  });

  it('官方公告区：普通用户不能发，管理员可以', async () => {
    const { db, admin, alice, service } = setup();
    const id = boardIdBySlug(db, 'announcements');
    expect((await service.canPostIn(caller(db, alice), id)).allowed).toBe(false);
    expect((await service.canPostIn(caller(db, admin), id)).allowed).toBe(true);
  });
});

describe('分区权限只在本区生效', () => {
  it('A 区区长在 B 区没有管理权', async () => {
    const { db, alice, service } = setup();
    const general = boardIdBySlug(db, 'general');
    await service.transferOwner(caller(db, insertUser(db, { role: 'admin' })), general, alice);

    const announcements = boardIdBySlug(db, 'announcements');
    expect(await service.boardRoleOf(general, alice)).toBe('owner');
    expect(await service.boardRoleOf(announcements, alice)).toBeNull();

    // 想在别的区设策略 → 403
    await expect(
      service.setPostingPolicy(caller(db, alice), announcements, 'everyone'),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
  });
});

describe('区长任命与罢免', () => {
  it('owner 可任命协管，协管不能被任命成 owner', async () => {
    const { db, alice, bob, service } = setup();
    const general = boardIdBySlug(db, 'general');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await service.transferOwner(adminCtx, general, alice);

    await service.appointModerator(caller(db, alice), general, bob);
    expect(await service.boardRoleOf(general, bob)).toBe('moderator');
    // 幂等
    await service.appointModerator(caller(db, alice), general, bob);
    const cnt = db
      .prepare("SELECT COUNT(*) AS c FROM forum_board_moderators WHERE board_id = ? AND role = 'moderator'")
      .get(general) as { c: number };
    expect(Number(cnt.c)).toBe(1);
  });

  it('协管不能罢免 owner（D6），站方管理员可以', async () => {
    const { db, alice, bob, service } = setup();
    const general = boardIdBySlug(db, 'general');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await service.transferOwner(adminCtx, general, alice);
    await service.appointModerator(caller(db, alice), general, bob);

    await expect(
      service.removeModerator(caller(db, bob), general, alice),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);

    // 站方管理员可以撤销 owner
    await service.removeModerator(adminCtx, general, alice);
    expect(await service.boardRoleOf(general, alice)).toBeNull();
  });

  it('不能撤销自己的身份', async () => {
    const { db, alice, service } = setup();
    const general = boardIdBySlug(db, 'general');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await service.transferOwner(adminCtx, general, alice);

    await expect(
      service.removeModerator(caller(db, alice), general, alice),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('转移 owner 后原 owner 降为协管', async () => {
    const { db, alice, bob, service } = setup();
    const general = boardIdBySlug(db, 'general');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await service.transferOwner(adminCtx, general, alice);
    await service.transferOwner(adminCtx, general, bob);

    expect(await service.boardRoleOf(general, bob)).toBe('owner');
    expect(await service.boardRoleOf(general, alice)).toBe('moderator');
    const board = db.prepare('SELECT owner_id FROM forum_boards WHERE id = ?').get(general) as { owner_id: string };
    expect(board.owner_id).toBe(bob);
  });
});

describe('白黑名单', () => {
  it('whitelist 分区：名单内可发，名单外不可；deny 能反过来禁掉名单内的人', async () => {
    const { db, alice, bob, service } = setup();
    const general = boardIdBySlug(db, 'general');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await service.transferOwner(adminCtx, general, alice);
    await service.setPostingPolicy(caller(db, alice), general, 'whitelist');

    expect((await service.canPostIn(caller(db, bob), general)).allowed).toBe(false);

    await service.setPostingRule(caller(db, alice), general, bob, 'allow');
    expect((await service.canPostIn(caller(db, bob), general)).allowed).toBe(true);

    await service.setPostingRule(caller(db, alice), general, bob, 'deny');
    expect((await service.canPostIn(caller(db, bob), general)).allowed).toBe(false);

    // 清除规则后回到「不在白名单」状态
    await service.setPostingRule(caller(db, alice), general, bob, null);
    expect((await service.canPostIn(caller(db, bob), general)).allowed).toBe(false);
  });
});

describe('官方分区的两条底线', () => {
  it('官方分区发帖策略不能改成非管理员', async () => {
    const { db, service } = setup();
    const announcements = boardIdBySlug(db, 'announcements');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await expect(
      service.setPostingPolicy(adminCtx, announcements, 'everyone'),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('官方分区不能被归档', async () => {
    const { db, service } = setup();
    const announcements = boardIdBySlug(db, 'announcements');
    const adminCtx = caller(db, insertUser(db, { role: 'admin' }));
    await expect(
      service.setBoardStatus(adminCtx, announcements, 'archived'),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('普通分区可以归档，归档后任何人都发不了', async () => {
    const { db, admin, service } = setup();
    const general = boardIdBySlug(db, 'general');
    await service.setBoardStatus(caller(db, admin), general, 'archived');
    expect((await service.canPostIn(caller(db, admin), general)).allowed).toBe(false);
  });
});
