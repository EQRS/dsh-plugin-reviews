#!/usr/bin/env node
/**
 * **手动排入一轮插件自动发现**（运维工具；也是"管理员立即发现"背后的同一件事）。
 *
 * 它只**排任务**，不自己跑发现：真正的执行在 worker 里（这样才和定时发现走同一条路径，
 * 也才有租约、重试、progress 这些保障）。排完可用 `node scripts/diagnose.mjs` 或后台页看结果。
 *
 * 用法（在项目根目录、与站点同一个库）：
 *   npx tsx scripts/discover-now.mjs                      # 按默认预算排一轮
 *   npx tsx scripts/discover-now.mjs --limit 20           # 覆盖单轮收录上限
 *   npx tsx scripts/discover-now.mjs --query 'topic:dsh'  # 换搜索词
 *
 * 库路径与站点一致：`DSH_REVIEW_DB_PATH`（默认 .data/app.sqlite）。
 * 幂等：默认用时间戳当审计键（每跑一次就是一轮）；`--dry-run` 只打印不排。
 *
 * ⚠️ 为什么用"排任务"而不是直接跑：未认证访问 GitHub 时核心接口只有 **60 次/小时**，
 * 直接把预算调大只会撞 403。要一次导得多，就给服务器加一个只读 `GITHUB_TOKEN`
 * （认证后 5000 次/小时），预算会自动放大（见 discoveryBudgetFor）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createTasksService } from '../src/server/modules/tasks/service.ts';
import { openDatabase, resolveDbPath } from '../src/server/platform/db.ts';
import { migrate } from '../src/server/platform/migrate.ts';
import { discoveryBudgetFor, DISCOVERY_DEFAULTS } from '../src/server/modules/catalog/discovery.ts';

/**
 * 读 `.env.local`（**不覆盖已有环境变量**）。
 *
 * 为什么必须自己读：systemd 给 worker 配了 `EnvironmentFile=.env.local`，
 * 所以 **worker 是读得到的**；但本脚本用 `npx tsx` 直接跑（不经过 Next），
 * 不读就会把"服务器已配 token"误判成"未认证"，从而给出偏小的预算。
 * 与站点配置不一致的运维脚本，比没有脚本更危险。
 */
function loadEnvLocal() {
  if (!existsSync('.env.local')) return 0;
  let loaded = 0;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // 真实环境变量优先
    process.env[key] = m[2].replace(/^["']|["']$/g, '').trim();
    loaded += 1;
  }
  return loaded;
}

const loadedKeys = loadEnvLocal();

const args = process.argv.slice(2);
const readArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');

const limitArg = readArg('limit');
const query = readArg('query') ?? DISCOVERY_DEFAULTS.query;
const budget = discoveryBudgetFor(process.env);
if (limitArg !== null) {
  const n = Number(limitArg);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--limit 需要正整数，收到：${limitArg}`);
    process.exit(2);
  }
  budget.maxPlugins = Math.floor(n);
}

const dbFile = resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
console.log(`库：${dbFile}`);
console.log(`已从 .env.local 加载 ${loadedKeys} 个变量（真实环境变量优先）`);
console.log(
  `预算：收录上限 ${budget.maxPlugins} 个 / 候选 ${budget.maxCandidates} 个 / 请求上限 ${budget.maxRequests} 次` +
    `（${(process.env.GITHUB_TOKEN ?? '').trim() ? '已认证' : '未认证，核心接口 60 次/小时'}）`,
);

if (dryRun) {
  console.log('--dry-run：只预览，不排任务。');
  process.exit(0);
}

// 先确保结构是最新的：排任务也是写库，不该写到旧结构上。
migrate({ file: dbFile });

const db = openDatabase({ file: dbFile });
try {
  const tasks = createTasksService(db);
  const runKey = `manual:${new Date().toISOString()}`;
  const { taskId, created } = await tasks.enqueue({
    taskType: 'plugin_discovery',
    deduplicationKey: runKey,
    requestedBy: null,
    payload: { run_key: runKey, query, ...budget },
    schedulingGroup: 'plugin_discovery_schedule',
    availableAt: Date.now(),
  });
  console.log(`已排入：task_id=${taskId} created=${created} run_key=${runKey}`);
  console.log('worker 会在下一次循环领走它（线上每 5 秒一次心跳，通常几秒内开始）。');
  console.log('看结果：node scripts/diagnose.mjs，或等 worker 日志里的「自动发现一轮结束」。');
} finally {
  db.close();
}
