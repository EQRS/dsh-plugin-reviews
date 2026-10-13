#!/usr/bin/env node
/**
 * worker 容器 HEALTHCHECK：读它自己写的心跳，太旧就判不健康。
 *
 * 为什么不用 HTTP：worker **不提供** HTTP（它只连库、只干活），
 * 所以"它还在不在"最直接的判据就是它写进库里的心跳。
 *
 * 退出码：0 = 心跳新鲜；1 = 没有心跳或已过期（编排器据此重启容器）。
 * 环境变量：DSH_REVIEW_DB_PATH、DSH_REVIEW_WORKER_HEARTBEAT_NAME、
 *          DSH_REVIEW_WORKER_STALE_MS（默认 60000，比 worker 的写入间隔宽得多）。
 *
 * 注意：不用 process.exit()，只设 exitCode 后自然结束 ——
 * better-sqlite3 在某些平台上配 process.exit() 会在退出时触发 libuv 断言崩溃。
 */

import Database from 'better-sqlite3';

const file = process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite';
const name = process.env.DSH_REVIEW_WORKER_HEARTBEAT_NAME ?? 'worker';
const staleMs = Number(process.env.DSH_REVIEW_WORKER_STALE_MS ?? 60_000);

let db;
try {
  db = new Database(file, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[healthcheck] 打不开库 ${file}：${e.message}`);
  process.exitCode = 1;
}

if (db) {
  let row;
  try {
    row = db.prepare('SELECT beat_at, started_at FROM runtime_heartbeats WHERE name = ?').get(name);
  } catch (e) {
    console.error(`[healthcheck] 读不到心跳表（迁移没跑到 0004？）：${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }

  if (process.exitCode !== 1) {
    if (!row) {
      console.error(`[healthcheck] worker 从未写过心跳（名字 ${name}）`);
      process.exitCode = 1;
    } else {
      const ageMs = Math.max(0, Date.now() - Number(row.beat_at));
      if (ageMs > staleMs) {
        console.error(
          `[healthcheck] worker 心跳已 ${Math.round(ageMs / 1000)} 秒未更新（上限 ${Math.round(staleMs / 1000)} 秒）`,
        );
        process.exitCode = 1;
      } else {
        const aliveMs = Math.max(0, Date.now() - Number(row.started_at));
        console.log(
          `[healthcheck] worker 正常：心跳 ${Math.round(ageMs / 1000)} 秒前，本轮已活 ${Math.round(aliveMs / 1000)} 秒`,
        );
      }
    }
  }
}
