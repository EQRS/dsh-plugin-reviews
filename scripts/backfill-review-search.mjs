#!/usr/bin/env node
/**
 * 回填评测检索索引（迁移 0014 之后跑一次；幂等，可反复执行）。
 *
 * 为什么需要它：索引是在**发布**时写入的，迁移前已经发布的评测没有索引行，
 * 不跑这一步会出现"老文章搜不到、新文章搜得到"这种最难解释的现象。
 *
 * 用法：npx tsx scripts/backfill-review-search.mjs
 */

import { getDb, resolveDbPath } from '../src/server/platform/db.ts';
import { createSearchService } from '../src/server/modules/search/index.ts';

process.env.DSH_REVIEW_DB_PATH = resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
const db = getDb();
const service = createSearchService({ db });

const count = await service.rebuildIndex();
console.log(`检索索引重建完成：${count} 篇已发布评测已写入 review_search。`);

const total = db.prepare('SELECT COUNT(*) AS c FROM review_search').get().c;
console.log(`索引行数：${total}（应与上面的条数一致）`);
if (total !== count) {
  console.error('⚠ 索引行数与重建条数不一致，请检查。');
  process.exitCode = 1;
}
