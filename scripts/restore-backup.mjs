#!/usr/bin/env node
/**
 * 恢复：把一份备份**验过再写回**，不做"赌一把"的恢复。
 *
 * 顺序刻意是「先验后写」：
 *   1. 读 manifest，核对 sha256 —— 文件被截断/换过就当场拒绝，不覆盖现有库；
 *   2. 在**临时副本**上跑 `PRAGMA integrity_check`，通过才落盘；
 *   3. 写回前把现有库改名为 `app.sqlite.corrupt-<时间戳>`（不删），恢复本身也可回退；
 *   4. 媒体可选（默认不动），要恢复得显式 `--media`。
 *
 * 用法：
 *   node scripts/restore-backup.mjs --latest --dry-run
 *   node scripts/restore-backup.mjs 20261018-030000-auto --force
 *   BACKUP_ROOT=... node scripts/restore-backup.mjs --latest --force --media
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const dbPath = resolve(value('target') ?? process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite');
const mediaRoot = resolve(process.env.DSH_REVIEW_MEDIA_ROOT ?? join(dirname(dbPath), 'media'));
const backupRoot = resolve(process.env.BACKUP_ROOT ?? join(dirname(dbPath), '..', 'backups'));
const dryRun = has('--dry-run');
const force = has('--force');
const withMedia = has('--media');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ---------- 选备份 ----------
let dirName = value('backup') ?? args.find((a) => /^\d{8}-\d{9}-/.test(a)) ?? null;
if (has('--latest')) {
  const dirs = readdirSync(backupRoot)
    .filter((n) => /^\d{8}-\d{9}-[a-z0-9-]+$/.test(n))
    .sort()
    .reverse();
  if (dirs.length === 0) fail(`备份目录里没有可用的备份：${backupRoot}`);
  dirName = dirs[0];
}
if (!dirName) fail('没指定备份。给一个目录名，或加 --latest。');

const srcDir = join(backupRoot, dirName);
if (!existsSync(srcDir)) fail(`备份目录不存在：${srcDir}`);

// ---------- 1) 验清单与 sha256 ----------
const manifestPath = join(srcDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`缺少 manifest.json：${srcDir}（这不像一份完整备份）`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.integrityOk === false) fail(`该备份在生成时就没通过完整性检查（integrity=${manifest.integrity}）`);

const srcDb = join(srcDir, manifest.dbFile ?? 'app.sqlite');
if (!existsSync(srcDb)) fail(`备份里没有库文件：${srcDb}`);
const actualSha = createHash('sha256').update(readFileSync(srcDb)).digest('hex');
if (manifest.dbSha256 && manifest.dbSha256 !== actualSha) {
  fail(`sha256 不匹配（清单 ${manifest.dbSha256.slice(0, 12)}… / 实际 ${actualSha.slice(0, 12)}…）—— 文件可能被改动或损坏`);
}

console.log('== 待恢复的备份 ==');
console.log(`  目录       ${srcDir}`);
console.log(`  生成于     ${manifest.createdAt}（label=${manifest.label}）`);
console.log(`  schema     ${manifest.schemaVersion ?? '(未知)'}`);
console.log(`  行数       ${Object.entries(manifest.counts ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  完整性     ${manifest.integrity}`);
console.log(`  sha256     ${actualSha.slice(0, 16)}…  ✓ 与清单一致`);

// ---------- 2) 在临时副本上验完整性 ----------
const probeDir = join(dirname(srcDb), '.restore-probe.sqlite');
try {
  copyFileSync(srcDb, probeDir);
  const probe = new Database(probeDir, { readonly: true });
  const check = probe.prepare('PRAGMA integrity_check').get()?.integrity_check;
  probe.close();
  if (check !== 'ok') fail(`副本完整性检查不通过：${check}`);
} finally {
  rmSync(probeDir, { force: true });
}
console.log('  临时副本完整性检查  ok');

// ---------- 3) 写回 ----------
if (dryRun) {
  console.log('\n--dry-run：只验证，不写。');
  process.exit(0);
}

const targetExists = existsSync(dbPath);
if (targetExists && !force) {
  fail(`目标已存在：${dbPath}\n  确认要覆盖就加 --force（现有库会被改名保留，不直接删）。`);
}

mkdirSync(dirname(dbPath), { recursive: true });
if (targetExists) {
  const aside = `${dbPath}.before-restore-${Date.now()}`;
  renameSync(dbPath, aside);
  console.log(`  现有库已改名保留：${aside}`);
}
// WAL/SHM 必须一起清掉，否则新库会带着旧日志启动。
for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
copyFileSync(srcDb, dbPath);
console.log(`  已写入：${dbPath}`);

if (withMedia) {
  const mediaTar = join(srcDir, 'media.tar.gz');
  if (!existsSync(mediaTar)) fail('--media 指定了媒体恢复，但这份备份里没有 media.tar.gz');
  mkdirSync(mediaRoot, { recursive: true });
  execFileSync('tar', ['-xzf', mediaTar, '-C', mediaRoot], { stdio: 'inherit' });
  console.log(`  媒体已恢复到：${mediaRoot}`);
} else if (existsSync(join(srcDir, 'media.tar.gz'))) {
  console.log('  （备份里有媒体包；需要一起恢复请加 --media）');
}

console.log('\n下一步：重启服务让它读到新库');
console.log('  cd /root/dsh-plugin-review/repo/docker && docker compose restart web worker');
console.log('  然后核对：curl -s http://127.0.0.1/api/health   （schema_version 应为 ' + (manifest.schemaVersion ?? '?') + '）');
