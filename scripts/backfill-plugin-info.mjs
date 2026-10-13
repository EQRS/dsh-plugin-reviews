#!/usr/bin/env node
/**
 * 回填插件展示资料（迁移 0005 之后的存量条目）。
 *
 * 背景：迁移 0005 加了"简介 / 作者 / topics / 仓库更新时间"等展示字段，但**存量行全是 NULL**
 * （字段是这次才加的）。新收录的条目在收录时就会写入，只有老条目需要回填。
 *
 * 做法：对缺 `plugins.info_updated_at` 的条目**逐条重跑一次收录检查**
 * （`acceptPluginSubmission` + 真实 GitHub 探针）—— 走的正是生产同一条路径：
 *   * 天然幂等（命中既有条目 → created=false → 只刷新资料，不新建行）；
 *   * 失败（限流/网络/仓库已删）只记录跳过，**不算失败退出**；
 *   * 不碰任何用户内容。
 *
 * 用法（仓库约定：脚本用 tsx 跑，才能直接 import .ts）：
 *   npx tsx scripts/backfill-plugin-info.mjs                 # 默认 dry-run，只列要处理哪些
 *   npx tsx scripts/backfill-plugin-info.mjs --apply         # 真写
 *   npx tsx scripts/backfill-plugin-info.mjs --apply --limit 5
 *
 * 退出码：0 = 完成（含"部分跳过"）；1 = 库都打不开这种硬故障。
 */

import { existsSync } from 'node:fs';
import { getDb, resolveDbPath } from '../src/server/platform/db.ts';
import { createCatalogService } from '../src/server/modules/catalog/index.ts';
import { createGithubCatalogProbe } from '../src/server/adapters/catalog/github-probe.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = !apply;
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '0', 10) || 0 : 0;

const dbPath = resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}（可用 DSH_REVIEW_DB_PATH 指定）`);
  process.exitCode = 1;
} else {
  const db = getDb();
  const service = createCatalogService({ db });

  /*
   * 用谁的身份回填？
   *
   * 实测：`acceptPluginSubmission` 对 `userId: null` 直接抛"收录插件需要先登录"——
   * 这是**故意的**安全约束（只有登录用户能收录插件），不该为了回填把它放宽。
   * 所以回填借用库里一个真实账号（优先管理员），并在结果里**明确打印用的是谁**：
   * 这条操作会写进 operation_records，事后查得到归属。
   */
  const caller = db
    .prepare(
      `SELECT id, role FROM users
        WHERE account_status = 'active'
        ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1`,
    )
    .get();

  if (!caller) {
    console.error('库里没有任何活跃用户，无法回填（收录操作需要登录身份）。先完成一次登录/指定管理员再跑。');
    process.exitCode = 1;
  } else {
    console.log(`回填身份：${caller.id}（role=${caller.role}）`);

    const targets = db
      .prepare(
        `SELECT p.id AS plugin_id, p.plugin_path, r.full_name, r.html_url
           FROM plugins p
           JOIN repositories r ON r.id = p.repository_id
          WHERE p.info_updated_at IS NULL
          ORDER BY p.created_at ASC${limit > 0 ? ` LIMIT ${limit}` : ''}`,
      )
      .all();

    console.log(`数据库：${dbPath}`);
    console.log(
      `待回填：${targets.length} 条${limit > 0 ? `（--limit ${limit}）` : ''}${dryRun ? '【dry-run，不写库】' : ''}`,
    );

    if (targets.length === 0) {
      console.log('没有需要回填的条目。');
    } else {
      const probe = createGithubCatalogProbe();
      let ok = 0;
      let skipped = 0;
      const failures = [];

      for (const row of targets) {
        const url = `${row.html_url}${
          row.plugin_path === '.' || row.plugin_path === '' ? '' : `/tree/HEAD/${row.plugin_path}`
        }`;
        const label = `${row.full_name}${row.plugin_path === '.' ? '' : ` / ${row.plugin_path}`}`;

        if (dryRun) {
          console.log(`  将处理：${label}`);
          continue;
        }

        try {
          await service.acceptPluginSubmission(
            { userId: caller.id, accountStatus: 'active', role: caller.role },
            { url, requestKey: `backfill-${row.plugin_id}` },
            { probe },
          );
          ok += 1;
          console.log(`  ✓ ${label}`);
        } catch (error) {
          skipped += 1;
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ label, message });
          console.log(`  - 跳过 ${label}：${message}`);
        }
      }

      if (!dryRun) {
        console.log(`\n完成：成功 ${ok} 条，跳过 ${skipped} 条。`);
        if (failures.length > 0) {
          console.log('跳过的明细（多为仓库已删/限流；重跑是幂等的，可稍后再来一次）：');
          for (const f of failures) console.log(`  - ${f.label}：${f.message}`);
        }
      }
    }
  }
}
