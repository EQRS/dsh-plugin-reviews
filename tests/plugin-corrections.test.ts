/**
 * 资料纠错（迁移 0015 / 0016）。
 *
 * 这一组最重要的用例是**"同步不能覆盖管理员修正"**：
 * 修正在 override 表里、同步值在 plugins 列里，两者分开存；收录/刷新只写没被覆盖的列。
 * 只写"采纳后能看到新值"的测试是抓不到这个 bug 的 —— 必须**在采纳之后再跑一次同步**。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createCorrectionsService } from '../src/server/modules/corrections';
import { createCatalogService } from '../src/server/modules/catalog';
import { createNotificationsService } from '../src/server/modules/notifications';
import { repoInfoStub, manifestStub } from './support/probe';
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

/** 造一个插件并给它一份"同步来的"资料。 */
function seedPlugin(db: TestDb['db'], name: string, description: string): { pluginId: string; repoId: string } {
  const repoId = insertRepository(db, `gh-${Math.random().toString(16).slice(2)}`);
  const pluginId = insertPlugin(db, repoId, '.');
  db.prepare('UPDATE plugins SET display_name = ?, description = ? WHERE id = ?').run(name, description, pluginId);
  return { pluginId, repoId };
}

const probe = {
  async fetchRepository() {
    return repoInfoStub({ githubRepositoryId: 'gh-sync-1', fullName: 'a/b', htmlUrl: 'https://github.com/a/b' });
  },
  async fetchPluginManifest() {
    return manifestStub({ name: '同步来的名字', description: '同步来的简介', bundlePath: './x.json' });
  },
};

describe('资料纠错：提交与校验', () => {
  it('能提交；同人同插件同建议值不产生第二条', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCorrectionsService({ db });
    const { pluginId } = seedPlugin(db, '旧名字', '旧简介');
    const user = insertUser(db, { nickname: '反馈者' });

    const first = await service.createCorrection(
      caller(db, user),
      { pluginId, proposed: { display_name: '新名字' }, description: 'README 里写的是新名字' },
      db,
    );
    expect(first.created).toBe(true);

    const again = await service.createCorrection(
      caller(db, user),
      { pluginId, proposed: { display_name: '新名字' }, description: '再提一次' },
      db,
    );
    expect(again.created).toBe(false);
    expect(again.correctionId).toBe(first.correctionId);
  });

  it('校验：未知字段 / 空建议 / 超长值 / 不存在的插件 / 匿名 都被拒', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCorrectionsService({ db });
    const { pluginId } = seedPlugin(db, '名字', '简介');
    const user = insertUser(db, { nickname: '反馈者' });
    const ctxUser = caller(db, user);

    await expect(
      service.createCorrection(ctxUser, { pluginId, proposed: { topics: ['x'] }, description: '改分类' }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createCorrection(ctxUser, { pluginId, proposed: {}, description: '空的' }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createCorrection(
        ctxUser,
        { pluginId, proposed: { display_name: 'x'.repeat(201) }, description: '太长' },
        db,
      ),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.createCorrection(ctxUser, { pluginId: 'no-such-plugin', proposed: { display_name: 'x' }, description: 'y' }, db),
    ).rejects.toMatchObject({ code: 'target_unavailable' });

    await expect(
      service.createCorrection(
        { userId: null, role: null, accountStatus: null },
        { pluginId, proposed: { display_name: 'x' }, description: 'y' },
        db,
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('资料纠错：处理', () => {
  it('采纳后展示修正值、写处理记录、通知提交者；驳回不改内容', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const corrections = createCorrectionsService({ db });
    const catalog = createCatalogService({ db });
    const { pluginId } = seedPlugin(db, '旧名字', '旧简介');
    const user = insertUser(db, { nickname: '反馈者' });
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });

    const created = await corrections.createCorrection(
      caller(db, user),
      {
        pluginId,
        proposed: { display_name: '新名字', description: '新简介' },
        description: 'GitHub README 已经改名了',
        referenceUrl: 'https://github.com/a/b',
      },
      db,
    );

    const handled = await corrections.handleCorrection(caller(db, admin), created.correctionId, {
      action: 'accept',
      reason: '核对 README 属实',
    }, db);
    expect(handled).toMatchObject({ state: 'accepted', action: 'accept' });

    // 读取侧已合并覆盖值
    const view = await catalog.getPlugin(pluginId);
    expect(view?.displayName).toBe('新名字');
    expect(view?.description).toBe('新简介');

    // 同步值原封不动地留在 plugins 里（这是"可恢复"的前提）
    const row = db.prepare('SELECT display_name, description FROM plugins WHERE id = ?').get(pluginId) as {
      display_name: string;
      description: string;
    };
    expect(row).toEqual({ display_name: '旧名字', description: '旧简介' });

    // 处理记录 + 通知（通知锚点为空 —— 插件不是 content_entity，迁移 0016 允许）
    const record = db
      .prepare('SELECT action, reason FROM plugin_correction_handling_records WHERE correction_request_id = ?')
      .get(created.correctionId) as { action: string; reason: string };
    expect(record).toEqual({ action: 'accept', reason: '核对 README 属实' });

    const inbox = await createNotificationsService({ db }).list(user, {});
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.kind).toBe('moderation_result');
    expect(inbox.items[0]!.contentEntityId).toBeNull();

    // 重复处理 → 冲突；非管理员 → 403
    await expect(
      corrections.handleCorrection(caller(db, admin), created.correctionId, { action: 'reject', reason: '再处理' }, db),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      corrections.handleCorrection(caller(db, user), created.correctionId, { action: 'accept', reason: '越权' }, db),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('**关键**：采纳之后再跑一次同步，修正不会被冲掉', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const corrections = createCorrectionsService({ db });
    const catalog = createCatalogService({ db });
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const author = insertUser(db, { nickname: '收录者' });

    // 先走一次真正的收录，拿到由同步写入的插件行
    const accepted = await catalog.acceptPluginSubmission(
      caller(db, author),
      { url: 'https://github.com/a/b', requestKey: `acc-${Date.now()}` },
      { probe },
    );
    expect((await catalog.getPlugin(accepted.pluginId))?.displayName).toBe('同步来的名字');

    // 采纳一条修正
    const created = await corrections.createCorrection(
      caller(db, author),
      { pluginId: accepted.pluginId, proposed: { display_name: '管理员确认的名字' }, description: 'README 改名' },
      db,
    );
    await corrections.handleCorrection(caller(db, admin), created.correctionId, {
      action: 'accept',
      reason: '属实',
    }, db);
    expect((await catalog.getPlugin(accepted.pluginId))?.displayName).toBe('管理员确认的名字');

    // 再跑一次同步（同 URL、不同 requestKey = 一次新的刷新）
    await catalog.acceptPluginSubmission(
      caller(db, author),
      { url: 'https://github.com/a/b', requestKey: `acc2-${Date.now()}` },
      { probe },
    );

    // 展示仍是修正值；同步值列也没被污染
    expect((await catalog.getPlugin(accepted.pluginId))?.displayName).toBe('管理员确认的名字');
    const row = db.prepare('SELECT display_name FROM plugins WHERE id = ?').get(accepted.pluginId) as {
      display_name: string;
    };
    expect(row.display_name).toBe('同步来的名字');

    // 恢复同步资料 → 回到同步值，且不需要重新探测
    expect(await corrections.revertOverride(caller(db, admin), accepted.pluginId, 'display_name', db)).toEqual({
      reverted: true,
    });
    expect((await catalog.getPlugin(accepted.pluginId))?.displayName).toBe('同步来的名字');
  });

  it('列表页也合并覆盖值（不是只有详情页）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const corrections = createCorrectionsService({ db });
    const catalog = createCatalogService({ db });
    const { pluginId } = seedPlugin(db, '旧名字', '旧简介');
    const user = insertUser(db, { nickname: '反馈者' });
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });

    const created = await corrections.createCorrection(
      caller(db, user),
      { pluginId, proposed: { description: '修正后的简介' }, description: '简介有误' },
      db,
    );
    await corrections.handleCorrection(caller(db, admin), created.correctionId, { action: 'accept', reason: '属实' }, db);

    const page = await catalog.listPlugins({ page: 1, page_size: 10 });
    expect(page.items.find((p) => p.pluginId === pluginId)?.description).toBe('修正后的简介');
  });
});
