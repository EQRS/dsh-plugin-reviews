/**
 * 评测检索（迁移 0014）。
 *
 * 要钉住的行为：
 *  1. **≥3 字符走 FTS5**（trigram 子串命中），1–2 字符走 LIKE 回退 —— 两条路都得有；
 *  2. 只返回**当前公开**的评测（撤回/隐藏/未发布的搜不到，即便索引里还有旧行）；
 *  3. 来源筛选、用途分类筛选能与关键词组合；
 *  4. 索引写入是幂等的（同一篇文章重复发布不会留下两行）；
 *  5. 插件搜索按匹配程度排序（名称全等 > 前缀 > 包含）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertReview, insertReviewRevision, insertUser, type TestDb } from './support/db';
import { createSearchService, reindexReviewInTx } from '../src/server/modules/search';
import { createCatalogService } from '../src/server/modules/catalog';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function makeReview(
  db: TestDb['db'],
  input: { title: string; body: string; sourceKind?: 'site' | 'community'; topics?: string[]; pluginName?: string },
): { reviewId: string; pluginId: string; authorId: string } {
  const authorId = insertUser(db, { nickname: '作者' });
  const repoId = insertRepository(db, `gh-${Math.random().toString(16).slice(2)}`);
  if (input.topics !== undefined) {
    db.prepare('UPDATE repositories SET topics = ? WHERE id = ?').run(
      input.topics.length > 0 ? JSON.stringify(input.topics) : null,
      repoId,
    );
  }
  const pluginId = insertPlugin(db, repoId);
  if (input.pluginName !== undefined) {
    db.prepare('UPDATE plugins SET display_name = ? WHERE id = ?').run(input.pluginName, pluginId);
  }
  const reviewId = insertReview(db, { authorId, pluginId });
  const revisionId = insertReviewRevision(db, {
    reviewId,
    pluginId,
    revisionNumber: 1,
    title: input.title,
    body: input.body,
  });
  const now = Date.now();
  db.prepare('UPDATE reviews SET published_revision_id = ?, source_kind = ? WHERE id = ?').run(
    revisionId,
    input.sourceKind ?? 'community',
    reviewId,
  );
  db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(
    now,
    now,
    reviewId,
  );
  reindexReviewInTx(db, reviewId);
  return { reviewId, pluginId, authorId };
}

describe('评测检索', () => {
  it('≥3 字符走 FTS5；2 字符走 LIKE 回退；都只返回公开评测', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createSearchService({ db });

    const a = makeReview(db, { title: '中文检索测试：一篇评测', body: '正文里讲了检索的实现' });
    makeReview(db, { title: '另一篇无关的评测', body: '这里讲的是别的东西' });

    // 3 字：走 FTS（trigram 子串）
    const fts = await service.searchReviews({ q: '检索测', page: 1, page_size: 20 });
    expect(fts.total).toBe(1);
    expect(fts.items[0]!.review_id).toBe(a.reviewId);

    // 2 字：trigram 不命中，靠 LIKE 回退
    const like = await service.searchReviews({ q: '检索', page: 1, page_size: 20 });
    expect(like.total).toBe(1);
    expect(like.items[0]!.review_id).toBe(a.reviewId);

    // 不存在的词
    expect((await service.searchReviews({ q: '完全不存在的词', page: 1, page_size: 20 })).total).toBe(0);
  });

  it('撤回 / 隐藏的评测搜不到（索引里还有旧行也不返回）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createSearchService({ db });
    const r = makeReview(db, { title: '会被撤回的评测', body: '正文' });

    expect((await service.searchReviews({ q: '会被撤回', page: 1, page_size: 20 })).total).toBe(1);

    const now = Date.now();
    // 触发器要求：可见性控制字段变化时 visibility_control_version 必须递增
    db
      .prepare(
        'UPDATE content_entities SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1 WHERE id = ?',
      )
      .run(now, '作者撤回', r.reviewId);
    expect((await service.searchReviews({ q: '会被撤回', page: 1, page_size: 20 })).total).toBe(0);

    // 索引行还在（证明是"查询时判可见性"，不是靠删索引）
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM review_search WHERE review_id = ?').get(r.reviewId) as { c: number }).c,
    ).toBe(1);
  });

  it('来源筛选与用途分类筛选可以和关键词组合', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createSearchService({ db });
    const adminId = insertUser(db, { nickname: '管理员', role: 'admin' });
    const admin = { userId: adminId, role: 'admin' as const, accountStatus: 'active' as const };
    await createCatalogService({ db }).upsertCategory(
      admin,
      { slug: 'zzmem', label: '测试记忆', topics: ['zzmemory'] },
      db,
    );

    const mem = makeReview(db, { title: '记忆插件评测', body: '正文', sourceKind: 'site', topics: ['zzmemory'] });
    makeReview(db, { title: '记忆插件评测二', body: '正文', sourceKind: 'community', topics: ['zzother'] });

    const siteOnly = await service.searchReviews({ q: '记忆插件', source: 'site', page: 1, page_size: 20 });
    expect(siteOnly.total).toBe(1);
    expect(siteOnly.items[0]!.review_id).toBe(mem.reviewId);

    const memOnly = await service.searchReviews({ q: '记忆插件', category: 'zzmem', page: 1, page_size: 20 });
    expect(memOnly.total).toBe(1);
    expect(memOnly.items[0]!.review_id).toBe(mem.reviewId);

    const otherCat = await service.searchReviews({ q: '记忆插件', category: 'integration', page: 1, page_size: 20 });
    expect(otherCat.total).toBe(0);
  });

  it('相关度：标题命中排在只有正文命中的前面', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createSearchService({ db });

    makeReview(db, {
      title: '完全无关的标题',
      body: '这是一段很长的正文，里面提到了目标关键词而且反复提到目标关键词，目标关键词目标关键词目标关键词。',
    });
    const titleHit = makeReview(db, { title: '目标关键词', body: '短正文' });

    const result = await service.searchReviews({ q: '目标关键词', page: 1, page_size: 20 });
    expect(result.total).toBe(2);
    expect(result.items[0]!.review_id).toBe(titleHit.reviewId);
  });

  it('重建索引是幂等的（同一篇不会留两行）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const r = makeReview(db, { title: '幂等测试', body: '正文' });
    reindexReviewInTx(db, r.reviewId);
    reindexReviewInTx(db, r.reviewId);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM review_search WHERE review_id = ?').get(r.reviewId) as {
      c: number;
    };
    expect(rows.c).toBe(1);

    const service = createSearchService({ db });
    expect(await service.rebuildIndex()).toBeGreaterThanOrEqual(1);
  });
});

describe('插件搜索相关度', () => {
  it('名称全等 > 名称前缀 > 只出现在简介里', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const catalog = createCatalogService({ db });

    function addPlugin(displayName: string, description: string): string {
      const repoId = insertRepository(db, `gh-${Math.random().toString(16).slice(2)}`);
      const pluginId = insertPlugin(db, repoId);
      db.prepare('UPDATE plugins SET display_name = ?, description = ? WHERE id = ?').run(
        displayName,
        description,
        pluginId,
      );
      return pluginId;
    }

    const inDescription = addPlugin('别的名字', '有一个 dsh-memory 的能力');
    const prefix = addPlugin('dsh-memory-plus', '扩展');
    const exact = addPlugin('dsh-memory', '本体');

    const page = await catalog.listPlugins({ q: 'dsh-memory', page: 1, page_size: 10 });
    const ids = page.items.map((p) => p.pluginId);
    expect(ids[0]).toBe(exact);
    expect(ids[1]).toBe(prefix);
    expect(ids[2]).toBe(inDescription);
  });
});
