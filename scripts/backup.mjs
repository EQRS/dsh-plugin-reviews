#!/usr/bin/env node
/**
 * 备份：一次跑出一个**完整恢复点**（库 + 媒体 + 清单），并当场自检。
 *
 * 设计取舍（都是被真实事故逼出来的）：
 *   * **用 SQLite 的在线热备 API**（`db.backup()`），不 `cp` 文件：
 *     WAL 模式下直接复制 `app.sqlite` 会漏掉还没 checkpoint 的事务，拷出来的库可能是坏的。
 *     `backup()` 由 SQLite 自己保证一致性，且**不阻塞写入**（站点照常用）。
 *   * **当场校验**：备份完立刻打开副本跑 `PRAGMA integrity_check` + 数一遍关键表。
 *     不做校验的备份只能叫"以为有备份"。
 *   * **清单（manifest.json）** 记录 schema 版本、各表行数、sha256、耗时 —— 恢复时靠它判断
 *     "这份备份是不是我要的那一份"，也靠它做恢复演练的证据。
 *   * **保留 N 份**（默认 14）：磁盘不会被历史备份塞满；超出按名字（带时间戳）删最旧。
 *
 * 用法：
 *   node scripts/backup.mjs                    # 默认写到 <data 同级>/backups
 *   node scripts/backup.mjs --label manual     # 标记来源（auto / manual / pre-deploy）
 *   node scripts/backup.mjs --keep 7 --json    # 保留 7 份，输出机器可读结果
 *
 * 环境变量：DSH_REVIEW_DB_PATH / DSH_REVIEW_MEDIA_ROOT / BACKUP_ROOT
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function arg(name, fallback = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const asJson = process.argv.includes('--json');
const label = String(arg('label', 'auto'));
const keep = Number(arg('keep', '14'));
const dbPath = resolve(process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite');
const mediaRoot = resolve(process.env.DSH_REVIEW_MEDIA_ROOT ?? join(dirname(dbPath), 'media'));
// 默认落在数据目录的**同级** backups/：宿主是 /root/dsh-plugin-review/{data,backups}，
// 容器里是 /app/{.data,backups}（compose 把宿主 backups 挂到 /app/backups）。
const backupRoot = resolve(process.env.BACKUP_ROOT ?? join(dirname(dbPath), '..', 'backups'));

if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const startedAt = Date.now();
// 目录名用**本地时间 + 毫秒**：秒级精度在连点两次「立即备份」时会撞名互相覆盖；
// 本地时间（容器里由 compose 的 TZ 指定）比 UTC 好读 —— 03:00 的备份就该叫 030000。
const now = new Date();
const pad = (n, len = 2) => String(n).padStart(len, '0');
const stamp =
  `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
  `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
const dirName = `${stamp}-${label}`;
const outDir = join(backupRoot, dirName);
mkdirSync(outDir, { recursive: true });

// ---------- 1) 库：在线热备 ----------
const src = new Database(dbPath, { readonly: true });
const destDbPath = join(outDir, 'app.sqlite');
await src.backup(destDbPath);

const schemaVersion =
  (
    src.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get() ?? { version: null }
  ).version ?? null;
const counts = {};
for (const table of ['users', 'plugins', 'repositories', 'reviews', 'comments', 'notifications']) {
  try {
    counts[table] = src.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  } catch {
    counts[table] = null; // 该备份对应的 schema 里没有这张表 —— 如实记 null，不假装 0
  }
}
src.close();

// ---------- 2) 媒体：有就打包 ----------
let mediaInfo = null;
if (existsSync(mediaRoot)) {
  const mediaTar = join(outDir, 'media.tar.gz');
  try {
    execFileSync('tar', ['-czf', mediaTar, '-C', mediaRoot, '.'], { stdio: 'pipe' });
    mediaInfo = { bytes: statSync(mediaTar).size };
  } catch (error) {
    // 媒体打包失败不该让整份备份"看起来成功"：记下来，退出码非 0。
    mediaInfo = { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------- 3) 自检：完整性 + 行数 ----------
const check = new Database(destDbPath, { readonly: true });
const integrity = check.prepare('PRAGMA integrity_check').get();
const verifyCounts = {};
for (const table of Object.keys(counts)) {
  try {
    verifyCounts[table] = check.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  } catch {
    verifyCounts[table] = null;
  }
}
check.close();

const integrityOk = integrity?.integrity_check === 'ok';
const countsMatch = Object.keys(counts).every((t) => counts[t] === verifyCounts[t]);
const sha256 = createHash('sha256').update(readFileSync(destDbPath)).digest('hex');

const manifest = {
  createdAt: new Date().toISOString(),
  label,
  dirName,
  dbFile: 'app.sqlite',
  schemaVersion,
  counts,
  verifyCounts,
  integrity: integrity?.integrity_check ?? 'unknown',
  integrityOk,
  countsMatch,
  dbBytes: statSync(destDbPath).size,
  dbSha256: sha256,
  media: mediaInfo,
  durationMs: Date.now() - startedAt,
  source: { dbPath, mediaRoot },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// ---------- 4) 保留策略 ----------
const removed = [];
if (Number.isInteger(keep) && keep > 0) {
  const dirs = readdirSync(backupRoot)
    .filter((name) => /^\d{8}-\d{9}-[a-z0-9-]+$/.test(name))
    .sort()
    .reverse();
  for (const old of dirs.slice(keep)) {
    rmSync(join(backupRoot, old), { recursive: true, force: true });
    removed.push(old);
  }
}

const ok = integrityOk && countsMatch && !(mediaInfo && 'error' in mediaInfo);
const result = { ok, outDir, manifest, removed, backupRoot };

if (asJson) {
  process.stdout.write(JSON.stringify(result));
} else {
  console.log(`== 备份${ok ? '完成' : '**不完整**'} ==`);
  console.log(`  目录       ${outDir}`);
  console.log(`  库         ${(manifest.dbBytes / 1024).toFixed(1)} KB（sha256 ${sha256.slice(0, 12)}…）`);
  console.log(`  schema     ${schemaVersion ?? '(未知)'}`);
  console.log(`  完整性     ${manifest.integrity}${integrityOk ? '' : ' ← 不合格'}`);
  console.log(
    `  行数       ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}${countsMatch ? '（副本一致）' : ' ← 副本与源不一致'}`,
  );
  if (mediaInfo) console.log(`  媒体       ${'error' in mediaInfo ? `打包失败：${mediaInfo.error}` : `${(mediaInfo.bytes / 1024).toFixed(1)} KB`}`);
  if (removed.length) console.log(`  清理       ${removed.length} 份旧备份（保留 ${keep} 份）`);
  console.log(`  用时       ${manifest.durationMs} ms`);
  if (!ok) console.log('\n⚠ 这份备份**不能**当作可恢复的备份，请检查上面的不合格项。');
}
process.exit(ok ? 0 : 1);
