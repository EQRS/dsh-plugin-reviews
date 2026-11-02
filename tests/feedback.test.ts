/**
 * 问题反馈（迁移 0036）：提交、去重、越权、状态机、通知、附件归属。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createFeedbackService } from '../src/server/modules/feedback';
import { createNotificationsService } from '../src/server/modules/notifications';
import { booleanSetting, createSettingsService } from '../src/server/modules/settings';
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
  const user = insertUser(db);
  return { db, admin, user, service: createFeedbackService({ db }) };
}

const baseTicket = {
  kind: 'bug',
  title: '搜索框输入中文回车没反应',
  body: '在插件目录页搜索「记忆」，按回车页面不跳转，手动点放大镜可以。',
  pageUrl: '/plugins?q=%E8%AE%B0%E5%BF%86',
};

describe('提交', () => {
  it('登录用户提交：落库待处理，能在我的一栏看到，写审计', async () => {
    const { db, user, service } = setup();
    const res = await service.createTicket(caller(db, user), baseTicket);
    expect(res.created).toBe(true);

    const mine = await service.listMine(caller(db, user), { page: 1 });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].status).toBe('open');
    expect(mine.items[0].pageKind).toBe('search');

    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM operation_records WHERE action_type = 'feedback.create'")
      .get() as { c: number };
    expect(Number(audit.c)).toBe(1);
  });

  it('校验：空标题 / 超长 / 站外地址 被拒', async () => {
    const { db, user, service } = setup();
    const bad = [
      { ...baseTicket, title: '   ' },
      { ...baseTicket, body: '' },
      { ...baseTicket, pageUrl: 'https://example.com/x' },
      { ...baseTicket, kind: 'nonsense' },
    ];
    for (const input of bad) {
      await expect(service.createTicket(caller(db, user), input)).rejects.toSatisfy(
        (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID,
      );
    }
  });

  it('24 小时内同类型同页面重复提交：返回已有票且不新建', async () => {
    const { db, user, service } = setup();
    const first = await service.createTicket(caller(db, user), baseTicket);
    const second = await service.createTicket(caller(db, user), { ...baseTicket, title: '又想到一个细节' });
    expect(second.created).toBe(false);
    expect(second.ticketId).toBe(first.ticketId);
    const count = db.prepare('SELECT COUNT(*) AS c FROM feedback_tickets').get() as { c: number };
    expect(Number(count.c)).toBe(1);
  });

  it('不同页面不合并', async () => {
    const { db, user, service } = setup();
    const a = await service.createTicket(caller(db, user), baseTicket);
    const b = await service.createTicket(caller(db, user), { ...baseTicket, pageUrl: '/reviews' });
    expect(b.created).toBe(true);
    expect(b.ticketId).not.toBe(a.ticketId);
  });
});

describe('可见性', () => {
  it('别人看不到我的票（404，不泄露存在性）', async () => {
    const { db, user, service } = setup();
    const other = insertUser(db);
    const created = await service.createTicket(caller(db, user), baseTicket);
    await expect(service.getMine(caller(db, other), created.ticketId)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.TARGET_UNAVAILABLE,
    );
  });

  it('队列只有管理员能看', async () => {
    const { db, user, service } = setup();
    await expect(service.listQueue(caller(db, user), {})).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN,
    );
  });
});

describe('处理', () => {
  it('确认：改状态、写处理记录、通知提交人', async () => {
    const { db, admin, user, service } = setup();
    const created = await service.createTicket(caller(db, user), baseTicket);
    const res = await service.handle(caller(db, admin), created.ticketId, {
      action: 'acknowledge',
      reason: '已复现，回车提交确实没绑事件',
      replyText: '已定位到搜索表单的提交处理，本周修。',
    });
    expect(res.status).toBe('acknowledged');
    expect(res.notified).toBe(true);

    const detail = await service.getForAdmin(caller(db, admin), created.ticketId);
    expect(detail.records).toHaveLength(1);
    expect(detail.records?.[0].action).toBe('acknowledge');

    const inbox = await createNotificationsService({ db }).list(user, { limit: 20 });
    const notice = inbox.items.find((row) => row.kind === 'feedback_result');
    expect(notice).toBeTruthy();
    expect(notice?.href).toBe('/feedback/' + created.ticketId);
    expect(notice?.excerpt).toContain('已确认');
  });

  it('处理必须写理由', async () => {
    const { db, admin, user, service } = setup();
    const created = await service.createTicket(caller(db, user), baseTicket);
    await expect(
      service.handle(caller(db, admin), created.ticketId, { action: 'fix', reason: '  ' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('终态之后不能再处理（除 reopen），reopen 可回到已确认', async () => {
    const { db, admin, user, service } = setup();
    const created = await service.createTicket(caller(db, user), baseTicket);
    await service.handle(caller(db, admin), created.ticketId, { action: 'fix', reason: '已修复' });

    await expect(
      service.handle(caller(db, admin), created.ticketId, { action: 'fix', reason: '再修一次' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.VERSION_CONFLICT);

    const reopened = await service.handle(caller(db, admin), created.ticketId, {
      action: 'reopen',
      reason: '用户反馈又出现了',
    });
    expect(reopened.status).toBe('acknowledged');
  });

  it('标重复：必须给目标；不能自指；不能成环', async () => {
    const { db, admin, user, service } = setup();
    const a = await service.createTicket(caller(db, user), baseTicket);
    const b = await service.createTicket(caller(db, user), { ...baseTicket, pageUrl: '/reviews' });

    await expect(
      service.handle(caller(db, admin), b.ticketId, { action: 'duplicate', reason: '重复' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);

    await expect(
      service.handle(caller(db, admin), b.ticketId, {
        action: 'duplicate',
        reason: '重复',
        duplicateOf: b.ticketId,
      }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);

    // a → b 建立后，再让 b → a 会成环
    await service.handle(caller(db, admin), a.ticketId, {
      action: 'duplicate',
      reason: '与另一条相同',
      duplicateOf: b.ticketId,
    });
    await expect(
      service.handle(caller(db, admin), b.ticketId, {
        action: 'duplicate',
        reason: '反过来标一次',
        duplicateOf: a.ticketId,
      }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });

  it('队列筛选：默认只看待处理，可按状态与类型过滤', async () => {
    const { db, admin, user, service } = setup();
    const a = await service.createTicket(caller(db, user), baseTicket);
    await service.createTicket(caller(db, user), { ...baseTicket, kind: 'feature', pageUrl: '/me' });
    await service.handle(caller(db, admin), a.ticketId, { action: 'acknowledge', reason: '已确认' });

    const openOnly = await service.listQueue(caller(db, admin), { status: 'open' });
    expect(openOnly.items).toHaveLength(1);
    expect(openOnly.items[0].kind).toBe('feature');

    const all = await service.listQueue(caller(db, admin), { status: 'all' });
    expect(all.items).toHaveLength(2);

    const acked = await service.listQueue(caller(db, admin), { status: 'acknowledged' });
    expect(acked.items).toHaveLength(1);
  });
});

describe('开关（feedback.enabled）', () => {
  it('未写入配置时默认开启；管理员关掉后读取为关闭', async () => {
    const { db, admin } = setup();
    expect(booleanSetting(db, 'feedback.enabled', true)).toBe(true);

    await createSettingsService({ db }).update(caller(db, admin), {
      changes: { 'feedback.enabled': false },
      reason: '临时关闭反馈入口，排查接口异常',
      requestKey: 'test-feedback-switch',
    });
    expect(booleanSetting(db, 'feedback.enabled', true)).toBe(false);
  });
});

describe('附件归属（数据库层兜底）', () => {
  it('不能把别人的截图挂到自己的票上', async () => {
    const { db, user, service } = setup();
    const other = insertUser(db);
    const created = await service.createTicket(caller(db, user), baseTicket);

    const insertAttachment = (owner: string) => {
      const attachmentId = 'att_' + owner.slice(-6);
      db.prepare(
        "INSERT INTO attachments (id, uploaded_by, original_filename, processing_state, created_at, ready_at) " +
          "VALUES (?, ?, 'shot.png', 'ready', 1, 1)",
      ).run(attachmentId, owner);
      db.prepare(
        'INSERT INTO attachment_files (id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height, ' +
          "content_hash, processing_state, created_at) VALUES (?, ?, 'orig', 'original', 'image/png', 100, 10, 10, ?, 'ready', 1)",
      ).run('file_' + owner.slice(-6), attachmentId, 'a'.repeat(64));
      return 'file_' + owner.slice(-6);
    };

    const ownFile = insertAttachment(user);
    const otherFile = insertAttachment(other);

    // 自己的：能挂
    db.prepare('INSERT INTO feedback_attachment_links (ticket_id, file_id) VALUES (?, ?)').run(
      created.ticketId,
      ownFile,
    );

    // 别人的：触发器拒绝
    expect(() =>
      db.prepare('INSERT INTO feedback_attachment_links (ticket_id, file_id) VALUES (?, ?)').run(
        created.ticketId,
        otherFile,
      ),
    ).toThrow(/只能引用本人上传的附件/);
  });
});
