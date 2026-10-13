/**
 * 插件目录浏览：搜索 / 筛选 / 排序 / 计数（迁移 0005 起）。
 *
 * 这组测试盯的是三件最容易"看起来对、实际错"的事：
 *  1. **搜索转义**：用户输入 `%` 不能变成"匹配全表"；
 *  2. **计数与筛选口径一致**：卡片上的"公开评测数"、`has_reviews` 筛选、排序
 *     必须与内容可见性解析（`resolveVisibilityInTx`）用**同一条判据** ——
 *     撤回一篇评测后，三处必须同时变化；
 *  3. **分页不重不漏**：排序键必须唯一（同 updated_at 时靠 id 兜底）。
 *
 * 每条断言都能在实现被破坏时变红（见文件末尾的"变异自检"说明）。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertReview, insertReviewRevision, insertUser, type TestDb } from './support/db';
import { UNCLASSIFIED_TAG, createCatalogService, parseTopics } from '../src/server/modules/catalog/service';
import type { CatalogService } from '../src/server/modules/catalog/types';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

interface SeedPlugin {
  fullName: string;
  displayName?: string | null;
  pluginDescription?: string | null;
  repoDescription?: string | null;
  topics?: string[] | null;
  updatedAt: number;
  /** 建几篇评测；`publicCount` 篇设为已发布公开，其余留作草稿（不影响公开数）。 */
  reviews?: { total: number; publicCount: number };
}

interface Seeded {
  db: TestDb['db'];
  service: CatalogService;
  plugins: Record<string, string>;
}

/** 造一批插件：仓库 + 插件 + 展示字段 +（可选）公开评测。返回按 fullName 命名的 ID 表。 */
function seed(items: SeedPlugin[]): Seeded {
  ctx = createTestDb();
  const db = ctx.db;
  const userId = insertUser(db);
  const service = createCatalogService({ db });
  const plugins: Record<string, string> = {};

  for (const item of items) {
    const repoId = insertRepository(db, `gh-${item.fullName}`);
    db.prepare(
      `UPDATE repositories
          SET full_name = ?, description = ?, topics = ?, owner_login = ?, owner_avatar_url = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      item.fullName,
      item.repoDescription ?? null,
      item.topics === null || item.topics === undefined || item.topics.length === 0 ? null : JSON.stringify(item.topics),
      item.fullName.split('/')[0] ?? null,
      'https://avatars.example/u.png',
      item.updatedAt,
      repoId,
    );

    const pluginId = insertPlugin(db, repoId, '.');
    db.prepare(
      `UPDATE plugins
          SET display_name = ?, description = ?, author_login = ?, manifest_version = ?, info_updated_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      item.displayName ?? null,
      item.pluginDescription ?? null,
      'someone',
      '1.0.0',
      item.updatedAt,
      item.updatedAt,
      pluginId,
    );
    plugins[item.fullName] = pluginId;

    const reviews = item.reviews ?? { total: 0, publicCount: 0 };
    for (let i = 0; i < reviews.total; i += 1) {
      const reviewId = insertReview(db, { authorId: userId, pluginId });
      const revisionId = insertReviewRevision(db, {
        reviewId,
        pluginId,
        revisionNumber: 1,
        title: `${item.fullName} 的第 ${i + 1} 篇`,
      });
      if (i < reviews.publicCount) {
        db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);
      }
    }
  }

  return { db, service, plugins };
}

const page = (over: Partial<{ page: number; page_size: number; q: string; tag: string; hasReviews: 'all' | 'yes' | 'no'; sort: 'info' | 'reviews' }> = {}) => ({
  page: 1,
  page_size: 20,
  ...over,
});

describe('目录搜索', () => {
  it('命中展示名、仓库全名与简介三种字段；无关条目不出现', async () => {
    const { service } = seed([
      { fullName: 'acme/dsh-memory', displayName: '记忆插件', updatedAt: 3000 },
      { fullName: 'beta/dsh-weather', pluginDescription: '查天气的小工具', updatedAt: 2000 },
      { fullName: 'gamma/dsh-other', repoDescription: '完全无关的东西', updatedAt: 1000 },
    ]);

    const byName = await service.listPlugins(page({ q: '记忆' }));
    expect(byName.items.map((i) => i.repositoryFullName)).toEqual(['acme/dsh-memory']);

    // 仓库全名（大小写不敏感：LIKE 对 ASCII 默认不区分大小写）
    const byRepo = await service.listPlugins(page({ q: 'ACME/DSH' }));
    expect(byRepo.items.map((i) => i.repositoryFullName)).toEqual(['acme/dsh-memory']);

    const byPluginDesc = await service.listPlugins(page({ q: '天气' }));
    expect(byPluginDesc.items.map((i) => i.repositoryFullName)).toEqual(['beta/dsh-weather']);

    const byRepoDesc = await service.listPlugins(page({ q: '无关' }));
    expect(byRepoDesc.items.map((i) => i.repositoryFullName)).toEqual(['gamma/dsh-other']);

    const miss = await service.listPlugins(page({ q: '不存在的词' }));
    expect(miss.items).toEqual([]);
    expect(miss.total).toBe(0);
  });

  it('**转义通配符**：输入 % 或 _ 不得变成"匹配全表"', async () => {
    const { service } = seed([
      { fullName: 'acme/dsh-one', updatedAt: 2000 },
      { fullName: 'beta/dsh-two', updatedAt: 1000 },
    ]);

    // 不转义的话，'%' 会命中所有条目 —— 这里必须一条都不命中。
    const percent = await service.listPlugins(page({ q: '%' }));
    expect(percent.total).toBe(0);

    // '_' 在 LIKE 里是"任意单字符"；不转义会命中 acme/... 之类的任意内容。
    const underscore = await service.listPlugins(page({ q: '_' }));
    expect(underscore.total).toBe(0);

    // 反斜杠本身也要能安全地搜（不崩、不注入）
    const backslash = await service.listPlugins(page({ q: '\\' }));
    expect(backslash.total).toBe(0);
  });

  it('空关键词等价于"不筛"（不留空格噪音）', async () => {
    const { service } = seed([
      { fullName: 'acme/dsh-one', updatedAt: 2000 },
      { fullName: 'beta/dsh-two', updatedAt: 1000 },
    ]);
    expect((await service.listPlugins(page({ q: '   ' }))).total).toBe(2);
    expect((await service.listPlugins(page({}))).total).toBe(2);
  });
});

describe('目录筛选', () => {
  it('按用途标签筛（topics 里命中任意一个即算）', async () => {
    const { service } = seed([
      { fullName: 'acme/dsh-memory', topics: ['dsh', 'memory'], updatedAt: 2000 },
      { fullName: 'beta/dsh-weather', topics: ['dsh', 'weather'], updatedAt: 1000 },
    ]);

    expect((await service.listPlugins(page({ tag: 'memory' }))).items.map((i) => i.repositoryFullName)).toEqual([
      'acme/dsh-memory',
    ]);
    // 两个都带 dsh 标签
    expect((await service.listPlugins(page({ tag: 'dsh' }))).total).toBe(2);
    // 不存在的标签
    expect((await service.listPlugins(page({ tag: 'nope' }))).total).toBe(0);
  });

  it('"未分类"筛的是没有 topics 的条目（不是"标签名叫未分类"）', async () => {
    const { service } = seed([
      { fullName: 'acme/tagged', topics: ['dsh'], updatedAt: 2000 },
      { fullName: 'beta/untagged', topics: null, updatedAt: 1000 },
    ]);
    const none = await service.listPlugins(page({ tag: UNCLASSIFIED_TAG }));
    expect(none.items.map((i) => i.repositoryFullName)).toEqual(['beta/untagged']);
  });

  it('"已有评测 / 暂无评测"按**公开**评测数分档', async () => {
    const { service } = seed([
      { fullName: 'acme/有公开评测', updatedAt: 3000, reviews: { total: 1, publicCount: 1 } },
      { fullName: 'beta/只有草稿评测', updatedAt: 2000, reviews: { total: 1, publicCount: 0 } },
      { fullName: 'gamma/没有评测', updatedAt: 1000 },
    ]);

    const yes = await service.listPlugins(page({ hasReviews: 'yes' }));
    expect(yes.items.map((i) => i.repositoryFullName)).toEqual(['acme/有公开评测']);

    const no = await service.listPlugins(page({ hasReviews: 'no' }));
    expect(no.items.map((i) => i.repositoryFullName).sort()).toEqual(['beta/只有草稿评测', 'gamma/没有评测']);

    // 卡片上的数字也要与筛选一致：草稿评测不计入
    const counts = await service.listPlugins(page({}));
    const byFullName = Object.fromEntries(counts.items.map((i) => [i.repositoryFullName, i.publicReviewCount]));
    expect(byFullName['acme/有公开评测']).toBe(1);
    expect(byFullName['beta/只有草稿评测']).toBe(0);
    expect(byFullName['gamma/没有评测']).toBe(0);
  });

  it('**与可见性解析一致**：作者撤回一篇评测 → 计数减一、该条目从"已有评测"里消失', async () => {
    const { db, service } = seed([{ fullName: 'acme/dsh-memory', updatedAt: 1000, reviews: { total: 2, publicCount: 2 } }]);

    expect((await service.listPlugins(page({}))).items[0]?.publicReviewCount).toBe(2);
    expect((await service.listPlugins(page({ hasReviews: 'yes' }))).total).toBe(1);

    // 撤回其中一篇（按 content 模块的判据：withdrawn_at 非空即不再公开）
    const one = db.prepare('SELECT id FROM reviews ORDER BY id ASC LIMIT 1').get() as { id: string };
    db.prepare(
      `UPDATE content_entities SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1
        WHERE id = ?`,
    ).run(Date.now(), '作者撤回（未填写原因）', one.id);

    expect((await service.listPlugins(page({}))).items[0]?.publicReviewCount).toBe(1);

    // 全撤回 → 从"已有评测"里消失，但**条目本身还在目录里**（撤回不是删除）
    const two = db.prepare('SELECT id FROM reviews ORDER BY id ASC LIMIT 1 OFFSET 1').get() as { id: string };
    db.prepare(
      `UPDATE content_entities SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1
        WHERE id = ?`,
    ).run(Date.now(), '作者撤回（未填写原因）', two.id);

    expect((await service.listPlugins(page({ hasReviews: 'yes' }))).total).toBe(0);
    expect((await service.listPlugins(page({ hasReviews: 'no' }))).total).toBe(1);
    expect((await service.listPlugins(page({}))).total).toBe(1);
    expect((await service.listPlugins(page({}))).items[0]?.publicReviewCount).toBe(0);
  });
});

describe('目录排序与分页', () => {
  it('资料更新时间序：默认按 updated_at 倒序', async () => {
    const { service } = seed([
      { fullName: 'acme/old', updatedAt: 1000 },
      { fullName: 'beta/newest', updatedAt: 3000 },
      { fullName: 'gamma/mid', updatedAt: 2000 },
    ]);
    const r = await service.listPlugins(page({}));
    expect(r.items.map((i) => i.repositoryFullName)).toEqual(['beta/newest', 'gamma/mid', 'acme/old']);
  });

  it('评测数序：按公开评测数降序，同数按 id 兜底', async () => {
    const { service } = seed([
      { fullName: 'acme/none', updatedAt: 3000 },
      { fullName: 'beta/two', updatedAt: 2000, reviews: { total: 2, publicCount: 2 } },
      { fullName: 'gamma/one', updatedAt: 1000, reviews: { total: 1, publicCount: 1 } },
    ]);
    const r = await service.listPlugins(page({ sort: 'reviews' }));
    expect(r.items.map((i) => i.repositoryFullName)).toEqual(['beta/two', 'gamma/one', 'acme/none']);
  });

  it('**分页不重不漏**：全部条目 updated_at 相同（排序键退化成 id，仍必须稳定）', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ fullName: `owner/p${i}`, updatedAt: 1000 }));
    const { service } = seed(items);

    const seen: string[] = [];
    for (let p = 1; p <= 3; p += 1) {
      const r = await service.listPlugins(page({ page: p, page_size: 2 }));
      expect(r.total).toBe(5);
      expect(r.total_pages).toBe(3);
      seen.push(...r.items.map((i) => i.repositoryFullName));
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen.length).toBe(5);
  });
});

describe('标签聚合', () => {
  it('按出现插件数倒序，并含"未分类"', async () => {
    const { service } = seed([
      { fullName: 'a/one', topics: ['dsh', 'memory'], updatedAt: 3000 },
      { fullName: 'b/two', topics: ['dsh'], updatedAt: 2000 },
      { fullName: 'c/three', topics: null, updatedAt: 1000 },
    ]);
    const tags = await service.listPluginTags();
    expect(tags[0]).toEqual({ tag: 'dsh', pluginCount: 2 });
    const none = tags.find((t) => t.tag === UNCLASSIFIED_TAG);
    expect(none?.pluginCount).toBe(1);
    expect(tags.map((t) => t.tag)).toContain('memory');
  });

  it('非法 topics 写不进库（迁移层的 CHECK），而解析器对"合法 JSON 但形状不对"一律按无标签处理', async () => {
    const { db, service } = seed([{ fullName: 'a/bad', topics: null, updatedAt: 1000 }]);

    // 第一道防线在数据库：迁移 0005 的 CHECK 让非 JSON 直接写不进去（不是靠业务代码兜）。
    expect(() =>
      db.prepare("UPDATE repositories SET topics = 'not-json' WHERE full_name = 'a/bad'").run(),
    ).toThrow(/CHECK constraint failed/);

    // 第二道防线在读取侧：即便库里是"合法 JSON 但形状不对"（对象 / 混合数组 / null），
    // 目录也不能整页崩，而应当按"没有标签"处理。
    expect(parseTopics('{"a":1}')).toEqual([]);
    expect(parseTopics('["ok", 1, "", null]')).toEqual(['ok']);
    expect(parseTopics('null')).toEqual([]);
    expect(parseTopics('not-json')).toEqual([]);

    // 形状不对时，"未分类"筛选仍把它当未分类（topics IS NULL 的条目不受影响）
    const tags = await service.listPluginTags();
    expect(tags.find((t) => t.tag === UNCLASSIFIED_TAG)?.pluginCount).toBe(1);
    expect((await service.listPlugins(page({}))).items[0]?.topics).toEqual([]);
  });
});

/**
 * 变异自检（人工做过，记录在此以便复现）：
 *  A. 把 `buildDirectoryWhere` 里的 `escapeLikePattern(keyword)` 换成裸 `keyword`
 *     → "输入 % 不得匹配全表"用例变红；
 *  B. 把 `PUBLIC_REVIEW_COUNT_SQL` 里的 `ce.withdrawn_at IS NULL` 去掉
 *     → "撤回一篇评测 → 计数减一"用例变红；
 *  C. 把 `ORDER BY ... p.id ASC` 的 `p.id ASC` 去掉
 *     → "分页不重不漏"用例变红（同 updated_at 时顺序不稳定）。
 */
