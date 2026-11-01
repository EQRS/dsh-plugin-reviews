/**
 * 精选专栏（迁移 0033）：期号、整份清单保存、乐观锁、发布校验、可见性、精选标签。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createFeaturedService, featuredCountsForPlugins } from '../src/server/modules/featured';
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

const anon: CallerContext = { userId: null, role: null, accountStatus: null };

function item(pluginId: string, overrides: Partial<{ summary: string; reason: string; score: number; detailUrl: string | null }> = {}) {
  return {
    pluginId,
    summary: overrides.summary ?? '把多步操作收成一条命令',
    reason: overrides.reason ?? '日常最常用的一个，装上就少记一堆参数',
    score: overrides.score ?? 88,
    detailUrl: overrides.detailUrl === undefined ? null : overrides.detailUrl,
  };
}

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const service = createFeaturedService({ db });
  return { db, admin, service };
}

describe('精选专栏：创建与期号', () => {
  it('创建草稿：期号从 1 递增，状态 draft，写审计', async () => {
    const { db, admin, service } = setup();
    const first = await service.createDraft(caller(db, admin), {
      title: '第一期',
      theme: '把命令行变成习惯',
      requestKey: 'k1',
    });
    const second = await service.createDraft(caller(db, admin), {
      title: '第二期',
      theme: '数据整理',
      requestKey: 'k2',
    });
    expect(first.issueNumber).toBe(1);
    expect(second.issueNumber).toBe(2);

    const detail = await service.getForEdit(caller(db, admin), 1);
    expect(detail.status).toBe('draft');
    expect(detail.publishedAt).toBeNull();

    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM operation_records WHERE action_type = 'featured.create'")
      .get() as { c: number };
    expect(Number(audit.c)).toBe(2);
  });

  it('同 requestKey 重复创建返回同一期（不会多出一期）', async () => {
    const { db, admin, service } = setup();
    const a = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'same' });
    const b = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'same' });
    expect(b.issueNumber).toBe(a.issueNumber);
    const count = db.prepare('SELECT COUNT(*) AS c FROM featured_columns').get() as { c: number };
    expect(Number(count.c)).toBe(1);
  });

  it('非管理员不能建 / 改 / 发 / 删', async () => {
    const { db, admin, service } = setup();
    const user = insertUser(db);
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });

    for (const run of [
      () => service.createDraft(caller(db, user), { title: 'T', theme: 'M', requestKey: 'x' }),
      () =>
        service.saveDraft(caller(db, user), created.issueNumber, {
          title: 'T',
          theme: 'M',
          prefaceMd: '前言',
          items: [item(pluginId)],
          expectedVersion: 0,
        }),
      () => service.publish(caller(db, user), created.issueNumber, { expectedVersion: 0 }),
      () => service.deleteDraft(caller(db, user), created.issueNumber),
    ]) {
      try {
        await run();
        throw new Error('应当被拒绝');
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
      }
    }
  });
});

describe('精选专栏：清单保存', () => {
  it('整份清单保存：顺序与逐项文案一起落库，position 规范化', async () => {
    const { db, admin, service } = setup();
    const pluginA = insertPlugin(db, insertRepository(db), '.');
    const pluginB = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });

    const saved = await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: '本期导语',
      items: [item(pluginA, { summary: 'A 的简述' }), item(pluginB, { summary: 'B 的简述' })],
      expectedVersion: 0,
    });
    expect(saved.stateVersion).toBe(1);

    // 换位：B 在前，文案跟着 B 走
    await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: '本期导语',
      items: [item(pluginB, { summary: 'B 的简述' }), item(pluginA, { summary: 'A 的简述' })],
      expectedVersion: 1,
    });

    const detail = await service.getForEdit(caller(db, admin), created.issueNumber);
    expect(detail.items.map((row) => row.pluginId)).toEqual([pluginB, pluginA]);
    expect(detail.items[0].summary).toBe('B 的简述');
    expect(detail.items.map((row) => row.position)).toEqual([0, 1]);
  });

  it('旧版本保存被拒（409），不覆盖他人编辑', async () => {
    const { db, admin, service } = setup();
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });
    await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: 'x',
      items: [],
      expectedVersion: 0,
    });

    try {
      await service.saveDraft(caller(db, admin), created.issueNumber, {
        title: 'T',
        theme: 'M',
        prefaceMd: 'x',
        items: [item(pluginId)],
        expectedVersion: 0,
      });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }
  });

  it('校验：重复插件 / 评分越界 / http 链接 / 空简述 都被拒绝', async () => {
    const { db, admin, service } = setup();
    const pluginA = insertPlugin(db, insertRepository(db), '.');
    const pluginB = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });

    const cases = [
      { items: [item(pluginA), item(pluginA)], label: '重复插件' },
      { items: [item(pluginA, { score: 101 })], label: '评分 101' },
      { items: [item(pluginA, { score: -1 })], label: '评分 -1' },
      { items: [item(pluginA, { detailUrl: 'http://example.com/x' })], label: 'http 链接' },
      { items: [item(pluginA, { summary: '  ' })], label: '空简述' },
    ];
    for (const row of cases) {
      try {
        await service.saveDraft(caller(db, admin), created.issueNumber, {
          title: 'T',
          theme: 'M',
          prefaceMd: 'x',
          items: row.items,
          expectedVersion: 0,
        });
        throw new Error(row.label + ' 应当被拒绝');
      } catch (e) {
        expect(isDomainError(e), row.label).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
      }
    }

    // 合法的 https 链接可以保存
    const ok = await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: 'x',
      items: [item(pluginB, { detailUrl: 'https://example.com/test-suite' })],
      expectedVersion: 0,
    });
    expect(ok.stateVersion).toBe(1);
  });
});

describe('精选专栏：发布与可见性', () => {
  it('发布校验：缺前言 / 无插件 被拒；补全后可发布', async () => {
    const { db, admin, service } = setup();
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });

    // 无插件 + 空前言
    try {
      await service.publish(caller(db, admin), created.issueNumber, { expectedVersion: 0 });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }

    await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: '这是前言',
      items: [item(pluginId)],
      expectedVersion: 0,
    });
    const published = await service.publish(caller(db, admin), created.issueNumber, { expectedVersion: 1 });
    expect(published.publishedAt).toBeGreaterThan(0);

    const detail = await service.getForEdit(caller(db, admin), created.issueNumber);
    expect(detail.status).toBe('published');
  });

  it('草稿对普通读者不可见；发布后匿名可读', async () => {
    const { db, admin, service } = setup();
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });
    await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginId)],
      expectedVersion: 0,
    });

    try {
      await service.getPublished(anon, created.issueNumber);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.TARGET_UNAVAILABLE);
    }

    await service.publish(caller(db, admin), created.issueNumber, { expectedVersion: 1 });
    const read = await service.getPublished(anon, created.issueNumber);
    expect(read.title).toBe('T');
    expect(read.items).toHaveLength(1);
    expect(read.items[0].score).toBe(88);

    const list = await service.listPublished({ page: 1 });
    expect(list.items.map((row) => row.issueNumber)).toEqual([1]);
  });

  it('已发布期可继续编辑；删除已发布被拒，删草稿可以', async () => {
    const { db, admin, service } = setup();
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const first = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k1' });
    await service.saveDraft(caller(db, admin), first.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginId)],
      expectedVersion: 0,
    });
    await service.publish(caller(db, admin), first.issueNumber, { expectedVersion: 1 });

    // 发布后改标题：允许
    const edited = await service.saveDraft(caller(db, admin), first.issueNumber, {
      title: '改过的标题',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginId)],
      expectedVersion: 2,
    });
    expect(edited.stateVersion).toBe(3);

    try {
      await service.deleteDraft(caller(db, admin), first.issueNumber);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }

    const second = await service.createDraft(caller(db, admin), { title: 'D', theme: 'M', requestKey: 'k2' });
    expect(await service.deleteDraft(caller(db, admin), second.issueNumber)).toEqual({ deleted: true });
  });

  it('插件不可访问/已归档仍显示，并带标记', async () => {
    const { db, admin, service } = setup();
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    db.prepare("UPDATE repositories SET availability_state = 'unavailable', is_archived = 1").run();

    const created = await service.createDraft(caller(db, admin), { title: 'T', theme: 'M', requestKey: 'k' });
    await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: 'T',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginId)],
      expectedVersion: 0,
    });
    const detail = await service.getForEdit(caller(db, admin), created.issueNumber);
    expect(detail.items[0].plugin.availabilityState).toBe('unavailable');
    expect(detail.items[0].plugin.isArchived).toBe(true);
  });

  it('改标题后按原期号仍可访问（URL 稳定）', async () => {
    const { db, admin, service } = setup();
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const created = await service.createDraft(caller(db, admin), { title: '原标题', theme: 'M', requestKey: 'k' });
    await service.saveDraft(caller(db, admin), created.issueNumber, {
      title: '新标题',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginId)],
      expectedVersion: 0,
    });
    const detail = await service.getPublished(caller(db, admin), created.issueNumber);
    expect(detail.title).toBe('新标题');
    expect(detail.issueNumber).toBe(created.issueNumber);
  });
});

describe('精选标签', () => {
  it('只统计已发布期的入选次数', async () => {
    const { db, admin, service } = setup();
    const pluginA = insertPlugin(db, insertRepository(db), '.');
    const pluginB = insertPlugin(db, insertRepository(db), '.');

    // 一期发布（含 A、B）
    const first = await service.createDraft(caller(db, admin), { title: 'T1', theme: 'M', requestKey: 'k1' });
    await service.saveDraft(caller(db, admin), first.issueNumber, {
      title: 'T1',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginA), item(pluginB)],
      expectedVersion: 0,
    });
    await service.publish(caller(db, admin), first.issueNumber, { expectedVersion: 1 });

    // 二期草稿（含 A）——不应计入
    const second = await service.createDraft(caller(db, admin), { title: 'T2', theme: 'M', requestKey: 'k2' });
    await service.saveDraft(caller(db, admin), second.issueNumber, {
      title: 'T2',
      theme: 'M',
      prefaceMd: '前言',
      items: [item(pluginA)],
      expectedVersion: 0,
    });

    const counts = featuredCountsForPlugins(db, [pluginA, pluginB]);
    expect(counts.get(pluginA)).toBe(1);
    expect(counts.get(pluginB)).toBe(1);
    expect(counts.get('not-a-plugin')).toBeUndefined();
  });
});
