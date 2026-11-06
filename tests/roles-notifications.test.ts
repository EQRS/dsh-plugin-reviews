/**
 * 用户身份体系：通知与限流（迁移 0041 + 两个投递函数 + role_application 频控）。
 *
 * 这组测试盯的是两件**容易「看起来做了、其实没生效」**的事：
 *  1. 重建 notifications 时的 **kind 并集** —— 少一个已有 kind，历史行会在拷表阶段被
 *     新表 CHECK 拒掉（INSERT INTO ... SELECT 逐行判约束），所以既有 kind 必须逐个实测
 *     「迁移后仍能写入」，而不是只看新表 DDL 里写了几个词；
 *  2. 频控规则与 SETTING_DEFINITIONS 的 **specKey 对齐** —— 规则里写了一个不存在的键，
 *     后台调这个值就永远不生效（配置项摆设）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import {
  createNotificationsService,
  deliverFeaturedPublishedNotification,
  deliverFeedbackResultNotification,
  deliverPluginClaimResultNotification,
  deliverRoleApplicationResultNotification,
} from '@/server/modules/notifications';
import { RATE_LIMIT_RULES, enforceRateLimit } from '@/server/platform/rate-limit';
import { SETTING_DEFINITIONS } from '@/server/modules/settings';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): { db: TestDb['db']; recipient: string; actor: string } {
  ctx = createTestDb();
  const db = ctx.db;
  const recipient = insertUser(db, { nickname: '收件人' });
  const actor = insertUser(db, { nickname: '处理人' });
  return { db, recipient, actor };
}

/** 直接读一行通知（绕过 service，用来验证落到库里的列）。 */
function readRow(db: TestDb['db'], dedupKey: string) {
  return db
    .prepare(
      'SELECT kind, comment_id, content_entity_id, detail, link_url, read_at FROM notifications WHERE deduplication_key = ?',
    )
    .get(dedupKey) as
    | {
        kind: string;
        comment_id: string | null;
        content_entity_id: string | null;
        detail: string | null;
        link_url: string | null;
        read_at: number | null;
      }
    | undefined;
}

/** 直接按 SQL 插一行：证明是**表约束**容不容得下某个 kind（不经过服务层）。 */
function insertRaw(
  db: TestDb['db'],
  input: {
    key: string;
    recipientId: string;
    actorId: string;
    kind: string;
    detail: string | null;
    linkUrl?: string | null;
    contentEntityId?: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO notifications (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)',
  ).run(
    'n-' + input.key,
    input.recipientId,
    input.kind,
    input.actorId,
    input.contentEntityId ?? null,
    input.key,
    input.detail,
    input.linkUrl ?? null,
    now,
  );
}

describe('迁移 0041：notifications 的 kind 并集', () => {
  it('两个新 kind 都能落到库里，且没有内容锚点、跳转地址在 link_url', () => {
    const { db, recipient, actor } = setup();

    const roleKey = 'role_application:app-1:' + recipient + ':approved';
    const roleResult = deliverRoleApplicationResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '你申请成为创作者已通过。',
      linkUrl: '/me/settings',
      deduplicationKey: roleKey,
      now: 1_700_000_000_000,
    });
    expect(roleResult).toEqual({ created: true, reason: null, recipientId: recipient });

    const claimKey = 'plugin_claim:claim-1:' + recipient + ':approved';
    const claimResult = deliverPluginClaimResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '插件认领已通过，插件已归到你名下。',
      linkUrl: '/me/my-plugins',
      deduplicationKey: claimKey,
      now: 1_700_000_000_001,
    });
    expect(claimResult).toEqual({ created: true, reason: null, recipientId: recipient });

    const roleRow = readRow(db, roleKey);
    expect(roleRow?.kind).toBe('role_application_result');
    expect(roleRow?.content_entity_id).toBeNull();
    expect(roleRow?.comment_id).toBeNull();
    expect(roleRow?.link_url).toBe('/me/settings');

    const claimRow = readRow(db, claimKey);
    expect(claimRow?.kind).toBe('plugin_claim_result');
    expect(claimRow?.link_url).toBe('/me/my-plugins');
  });

  it('迁移后其余既有 kind 仍能写入（并集没漏：5 个老 kind 逐个实测）', () => {
    const { db, recipient, actor } = setup();

    for (const kind of ['moderation_result', 'featured_published', 'feedback_result']) {
      insertRaw(db, { key: 'raw-' + kind, recipientId: recipient, actorId: actor, kind, detail: '说明', linkUrl: '/x' });
    }
    for (const kind of ['role_application_result', 'plugin_claim_result']) {
      insertRaw(db, { key: 'raw-' + kind, recipientId: recipient, actorId: actor, kind, detail: '说明', linkUrl: '/y' });
    }

    const rows = db
      .prepare("SELECT kind FROM notifications WHERE deduplication_key LIKE 'raw-%' ORDER BY kind")
      .all() as Array<{ kind: string }>;
    expect(rows.map((r) => r.kind)).toEqual([
      'featured_published',
      'feedback_result',
      'moderation_result',
      'plugin_claim_result',
      'role_application_result',
    ]);
  });

  it('评论类 kind 仍然要求 comment_id 存在（重建没有把组合 CHECK 放宽）', () => {
    const { db, recipient, actor } = setup();
    expect(() =>
      db
        .prepare(
          "INSERT INTO notifications (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at) VALUES ('n-x', ?, 'comment_on_content', ?, NULL, NULL, 'raw-coc', NULL, NULL, NULL, 1)",
        )
        .run(recipient, actor),
    ).toThrow(/CHECK/i);
  });

  it('栏目类 kind 没有 detail 必须被拒（结果说明是必填，不许空通知）', () => {
    const { db, recipient, actor } = setup();
    expect(() =>
      insertRaw(db, {
        key: 'raw-nodetail',
        recipientId: recipient,
        actorId: actor,
        kind: 'role_application_result',
        detail: null,
      }),
    ).toThrow(/CHECK/i);
  });

  it('link_url 列存在、可写、可读回：list() 把它当作跳转地址', async () => {
    const { db, recipient, actor } = setup();
    deliverPluginClaimResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '认领已驳回。',
      linkUrl: '/me/my-plugins',
      deduplicationKey: 'plugin_claim:c2:' + recipient + ':rejected',
      now: 1_700_000_000_002,
    });

    const service = createNotificationsService({ db });
    const list = await service.list(recipient, {});
    expect(list.items).toHaveLength(1);
    expect(list.items[0].kind).toBe('plugin_claim_result');
    expect(list.items[0].href).toBe('/me/my-plugins');
    expect(list.items[0].excerpt).toBe('认领已驳回。');
    expect(list.unreadCount).toBe(1);
  });

  it('既有栏目类投递函数在迁移后仍工作（featured_published / feedback_result）', () => {
    const { db, recipient, actor } = setup();
    const featured = deliverFeaturedPublishedNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '精选第 3 期已发布。',
      linkUrl: '/columns/featured/3',
      deduplicationKey: 'featured:3:' + recipient,
      now: 1_700_000_000_003,
    });
    const feedback = deliverFeedbackResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '你的反馈已修复。',
      linkUrl: '/feedback/ft-1',
      deduplicationKey: 'feedback:ft-1:' + recipient,
      now: 1_700_000_000_004,
    });
    expect(featured.created).toBe(true);
    expect(feedback.created).toBe(true);
    expect(readRow(db, 'featured:3:' + recipient)?.kind).toBe('featured_published');
    expect(readRow(db, 'feedback:ft-1:' + recipient)?.kind).toBe('feedback_result');
  });
});

describe('新的两个投递函数：行为', () => {
  it('同一 deduplicationKey 重复调用只写一条（第二次报 duplicate）', () => {
    const { db, recipient, actor } = setup();
    const key = 'role_application:app-9:' + recipient + ':approved';
    const first = deliverRoleApplicationResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '通过。',
      linkUrl: '/me/settings',
      deduplicationKey: key,
      now: 1_700_000_000_010,
    });
    const second = deliverRoleApplicationResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '通过。',
      linkUrl: '/me/settings',
      deduplicationKey: key,
      now: 1_700_000_000_011,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, reason: 'duplicate', recipientId: recipient });

    const count = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
    expect(Number(count.c)).toBe(1);
  });

  it('认领结果同一键重复也去重', () => {
    const { db, recipient, actor } = setup();
    const key = 'plugin_claim:claim-9:' + recipient + ':approved';
    function mk() {
      return deliverPluginClaimResultNotification(db, {
        recipientId: recipient,
        actorId: actor,
        detail: '通过。',
        linkUrl: '/me/my-plugins',
        deduplicationKey: key,
        now: 1_700_000_000_012,
      });
    }
    expect(mk().created).toBe(true);
    expect(mk().reason).toBe('duplicate');
  });

  it('不同结果（驳回后再通过）不算重复，各发一条', () => {
    const { db, recipient, actor } = setup();
    const had = deliverRoleApplicationResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '材料不足，已驳回。',
      linkUrl: '/me/settings',
      deduplicationKey: 'role_application:app-10:' + recipient + ':rejected',
      now: 1_700_000_000_013,
    });
    const approved = deliverRoleApplicationResultNotification(db, {
      recipientId: recipient,
      actorId: actor,
      detail: '补充材料后通过。',
      linkUrl: '/me/settings',
      deduplicationKey: 'role_application:app-10:' + recipient + ':approved',
      now: 1_700_000_000_014,
    });
    expect(had.created).toBe(true);
    expect(approved.created).toBe(true);
    const count = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
    expect(Number(count.c)).toBe(2);
  });

  it('自己不通知自己：收件人 = 处理人时不写库', () => {
    const { db, recipient } = setup();
    const self = deliverRoleApplicationResultNotification(db, {
      recipientId: recipient,
      actorId: recipient,
      detail: '通过。',
      linkUrl: '/me/settings',
      deduplicationKey: 'role_application:self:' + recipient,
      now: 1_700_000_000_015,
    });
    expect(self).toEqual({ created: false, reason: 'self', recipientId: recipient });
    const count = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
    expect(Number(count.c)).toBe(0);
  });

  it('空白说明 / 空白跳转地址是编程错误，抛出而不是写一条空通知', () => {
    const { db, recipient, actor } = setup();
    expect(() =>
      deliverRoleApplicationResultNotification(db, {
        recipientId: recipient,
        actorId: actor,
        detail: '   ',
        linkUrl: '/me/settings',
        deduplicationKey: 'k-empty-detail',
        now: 1_700_000_000_016,
      }),
    ).toThrow();
    expect(() =>
      deliverPluginClaimResultNotification(db, {
        recipientId: recipient,
        actorId: actor,
        detail: '通过。',
        linkUrl: '  ',
        deduplicationKey: 'k-empty-link',
        now: 1_700_000_000_017,
      }),
    ).toThrow();
    const count = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
    expect(Number(count.c)).toBe(0);
  });
});

describe('限流：role_application（每用户每天 3 次）', () => {
  it('规则口径：3 次 / 天，specKey 与可配置清单逐字一致（后台调这个值真能生效）', () => {
    const rule = RATE_LIMIT_RULES.role_application;
    expect(rule.specKey).toBe('rate_limits.role_applications_per_day');
    expect(rule.points).toBe(3);
    expect(rule.durationMs).toBe(86_400_000);

    const def = SETTING_DEFINITIONS.find((d) => d.key === rule.specKey);
    expect(def, '频控规则 role_application 的 specKey 不在可配置清单里').toBeDefined();
    expect(def!.kind).toBe('integer');
    expect(def!.defaultValue).toBe(rule.points);
  });

  it('前 3 次放行，第 4 次被拒（429 语义）', async () => {
    const { db, recipient } = setup();
    for (let i = 0; i < 3; i++) {
      await expect(enforceRateLimit(db, 'role_application', recipient)).resolves.toBeTruthy();
    }
    await expect(enforceRateLimit(db, 'role_application', recipient)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('额度按用户隔离：A 用完不影响 B', async () => {
    const { db, recipient } = setup();
    const other = insertUser(db, { nickname: '另一个人' });
    for (let i = 0; i < 3; i++) await enforceRateLimit(db, 'role_application', recipient);
    await expect(enforceRateLimit(db, 'role_application', other)).resolves.toBeTruthy();
  });

  it('与评论变更互不干扰（一个动作一个独立额度）', async () => {
    const { db, recipient } = setup();
    for (let i = 0; i < 3; i++) await enforceRateLimit(db, 'role_application', recipient);
    await expect(enforceRateLimit(db, 'comment_change', recipient)).resolves.toBeTruthy();
  });
});
