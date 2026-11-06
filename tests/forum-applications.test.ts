/**
 * 讨论区 · 分区申请与审核（迁移 0037）。
 *
 * 重点测：
 *   1. 只有站方管理员能审；
 *   2. 通过时建分区 + 申请人成为 owner + 发通知；
 *   3. slug 与现有分区/其它待审申请冲突时拒绝；
 *   4. 审过的不能再审；拒绝必须写理由。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumBoardApplicationService } from '../src/server/modules/forum/applications';
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
  return {
    db,
    admin,
    alice,
    bob,
    apps: createForumBoardApplicationService({ db }),
    boards: createForumBoardService({ db }),
  };
}

const baseApp = {
  name: '机械键盘',
  slug: 'keyboards',
  description: '聊键帽与轴体',
  reason: '评测站里键盘相关内容很多，想集中讨论。',
};

describe('提交申请', () => {
  it('登录用户可提交，理由必填', async () => {
    const { db, alice, apps } = setup();
    const { applicationId } = await apps.submit(caller(db, alice), baseApp);
    expect(applicationId).toBeTruthy();

    const mine = await apps.listMine(caller(db, alice));
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('pending');

    await expect(
      apps.submit(caller(db, alice), { ...baseApp, slug: 'k2', reason: '   ' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('slug 格式不合法被拒', async () => {
    const { db, alice, apps } = setup();
    await expect(
      apps.submit(caller(db, alice), { ...baseApp, slug: 'Bad Slug!' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('slug 与现有分区冲突被拒', async () => {
    const { db, alice, apps } = setup();
    await expect(
      apps.submit(caller(db, alice), { ...baseApp, slug: 'general' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('同一 slug 已有待审申请时不能再提交', async () => {
    const { db, alice, bob, apps } = setup();
    await apps.submit(caller(db, alice), baseApp);
    await expect(apps.submit(caller(db, bob), baseApp)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID,
    );
  });

  it('被拒后可以再申请同一个 slug', async () => {
    const { db, admin, alice, apps } = setup();
    const first = await apps.submit(caller(db, alice), baseApp);
    await apps.reject(caller(db, admin), first.applicationId, '暂不单开分区');
    await expect(apps.submit(caller(db, alice), baseApp)).resolves.toBeTruthy();
  });
});

describe('审核队列', () => {
  it('只有站方管理员能看', async () => {
    const { db, admin, alice, apps } = setup();
    await apps.submit(caller(db, alice), baseApp);
    await expect(apps.listQueue(caller(db, alice))).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN,
    );
    const queue = await apps.listQueue(caller(db, admin));
    expect(queue.items).toHaveLength(1);
  });

  it('普通用户不能审批', async () => {
    const { db, alice, apps } = setup();
    const { applicationId } = await apps.submit(caller(db, alice), baseApp);
    await expect(apps.approve(caller(db, alice), applicationId)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN,
    );
  });
});

describe('通过', () => {
  it('建分区 + 申请人成为 owner + 发通知', async () => {
    const { db, admin, alice, apps, boards } = setup();
    const { applicationId } = await apps.submit(caller(db, alice), baseApp);
    const { boardId } = await apps.approve(caller(db, admin), applicationId, '欢迎');

    const board = db.prepare('SELECT slug, name, posting_policy, owner_id FROM forum_boards WHERE id = ?').get(boardId) as {
      slug: string;
      name: string;
      posting_policy: string;
      owner_id: string;
    };
    expect(board.slug).toBe('keyboards');
    expect(board.name).toBe('机械键盘');
    expect(board.posting_policy).toBe('everyone');
    expect(board.owner_id).toBe(alice);

    expect(await boards.boardRoleOf(boardId, alice)).toBe('owner');

    const notices = db.prepare('SELECT recipient_id, kind, detail FROM notifications').all() as Array<{
      recipient_id: string;
      kind: string;
      detail: string;
    }>;
    expect(notices).toHaveLength(1);
    expect(notices[0].recipient_id).toBe(alice);
    expect(notices[0].detail).toContain('已通过审核');
  });

  it('审过的不能再审（幂等冲突）', async () => {
    const { db, admin, alice, apps } = setup();
    const { applicationId } = await apps.submit(caller(db, alice), baseApp);
    await apps.approve(caller(db, admin), applicationId);
    await expect(apps.approve(caller(db, admin), applicationId)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID,
    );
  });

  it('通过后 slug 被别人抢先占用时拒绝通过', async () => {
    const { db, admin, alice, apps } = setup();
    const { applicationId } = await apps.submit(caller(db, alice), baseApp);
    // 模拟排队期间有人直接建了同名分区
    const now = Date.now();
    db.prepare(
      "INSERT INTO forum_boards (id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run('b_x', 'keyboards', '抢先的', admin, now, now);

    await expect(apps.approve(caller(db, admin), applicationId)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID,
    );
  });
});

describe('拒绝', () => {
  it('必须写理由，且发通知给申请人', async () => {
    const { db, admin, alice, apps } = setup();
    const { applicationId } = await apps.submit(caller(db, alice), baseApp);

    await expect(apps.reject(caller(db, admin), applicationId, '   ')).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID,
    );

    await apps.reject(caller(db, admin), applicationId, '内容量还不足以单开分区');
    const row = db.prepare('SELECT status, review_note FROM forum_board_applications WHERE id = ?').get(applicationId) as {
      status: string;
      review_note: string;
    };
    expect(row.status).toBe('rejected');
    expect(row.review_note).toContain('内容量');

    const notice = db.prepare('SELECT detail FROM notifications').get() as { detail: string };
    expect(notice.detail).toContain('未通过');
  });
});
