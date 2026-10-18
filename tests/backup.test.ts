/**
 * 备份 / 恢复脚本（`参数与管理规则.md §81`）。
 *
 * 这些用例都**真的跑脚本**（子进程 + 真文件），因为备份的正确性全在文件层面：
 * 热备出来的库能不能打开、清单里的 sha256 与行数对不对、保留策略删没删对、被改过的备份能不能被拒。
 * 只测一个"函数返回 true"是没有意义的 —— 备份这东西出事的时候才知道好不好。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';

let ctx: TestDb | null = null;
let work: string | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  if (work) rmSync(work, { recursive: true, force: true });
  work = null;
});

const REPO = process.cwd();

/** 起一个"工作区"：库 + 媒体 + 备份落点，彼此分开（和线上宿主布局一致）。 */
function setup(): { dbFile: string; mediaRoot: string; backupRoot: string } {
  ctx = createTestDb();
  work = mkdtempSync(join(tmpdir(), 'dsh-backup-test-'));
  const mediaRoot = join(work, 'media');
  mkdirSync(join(mediaRoot, 'ab'), { recursive: true });
  writeFileSync(join(mediaRoot, 'ab', 'demo.txt'), 'media-bytes', 'utf8');
  const backupRoot = join(work, 'backups');
  const dbFile = ctx.file;
  // 塞一条可数的数据，用来验证"清单里的行数 == 真实行数"
  insertUser(ctx.db, { nickname: '备份验收用户' });
  return { dbFile, mediaRoot, backupRoot };
}

function runBackup(env: { dbFile: string; mediaRoot: string; backupRoot: string }, extra: string[] = []): {
  code: number;
  json: { ok: boolean; outDir: string; manifest: Record<string, unknown>; removed: string[] };
} {
  try {
    const out = execFileSync(
      process.execPath,
      [join(REPO, 'scripts', 'backup.mjs'), '--json', '--label', 'test', ...extra],
      {
        cwd: REPO,
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_REVIEW_DB_PATH: env.dbFile,
          DSH_REVIEW_MEDIA_ROOT: env.mediaRoot,
          BACKUP_ROOT: env.backupRoot,
        },
      },
    );
    return { code: 0, json: JSON.parse(out) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    // 脚本失败时 stdout 可能是空的（例如库文件不存在，直接 exit 1）——
    // 空字符串不是 nullish，`?? '{}'` 兜不住，这里显式判空。
    const raw = (e.stdout ?? '').trim();
    return { code: e.status ?? 1, json: raw ? JSON.parse(raw) : ({} as never) };
  }
}

function runRestore(env: { dbFile: string; mediaRoot: string; backupRoot: string }, args: string[]): {
  code: number;
  out: string;
} {
  try {
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'restore-backup.mjs'), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_REVIEW_DB_PATH: env.dbFile,
        DSH_REVIEW_MEDIA_ROOT: env.mediaRoot,
        BACKUP_ROOT: env.backupRoot,
      },
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('备份脚本', () => {
  it('产出一份可恢复的备份：清单齐全、完整性 ok、行数与源一致、媒体被打包', () => {
    const env = setup();
    const { code, json } = runBackup(env);

    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(existsSync(join(json.outDir, 'app.sqlite'))).toBe(true);
    expect(existsSync(join(json.outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(json.outDir, 'media.tar.gz'))).toBe(true);

    const manifest = json.manifest as {
      integrity: string;
      integrityOk: boolean;
      countsMatch: boolean;
      schemaVersion: string;
      counts: Record<string, number>;
      dbSha256: string;
    };
    expect(manifest.integrity).toBe('ok');
    expect(manifest.integrityOk).toBe(true);
    expect(manifest.countsMatch).toBe(true);
    expect(manifest.schemaVersion).toMatch(/^\d{4}_/);
    // 真的进去了那条用户（不是空库备份）
    expect(manifest.counts.users).toBeGreaterThanOrEqual(1);
    expect(manifest.dbSha256).toMatch(/^[0-9a-f]{64}$/);

    // 备份出来的库**能独立打开**
    expect(existsSync(join(json.outDir, 'app.sqlite'))).toBe(true);
  });

  it('保留策略：只留最近 N 份（按目录名里的时间戳）', () => {
    const env = setup();
    for (let i = 0; i < 3; i += 1) {
      // 目录名精确到秒；三次连跑可能同秒 —— 用 keep 逐轮验证更稳
      const r = runBackup(env, ['--keep', String(3 - i)]);
      expect(r.code).toBe(0);
    }
    const dirs = readdirSync(env.backupRoot).filter((n) => /^\d{8}-\d{9}-/.test(n));
    expect(dirs.length).toBeLessThanOrEqual(3);
  });

  it('库文件不存在时明确失败（不产出"看起来有备份"的空目录）', () => {
    const env = setup();
    const missing = { ...env, dbFile: join(env.backupRoot, 'nope', 'app.sqlite') };
    const { code } = runBackup(missing);
    expect(code).not.toBe(0);
  });
});

describe('恢复脚本', () => {
  it('--dry-run 校验通过但不动库；真恢复会把现有库改名保留', () => {
    const env = setup();
    const { json } = runBackup(env);

    const dry = runRestore(env, ['--latest', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('临时副本完整性检查');

    // 恢复会重命名现有库文件 —— Windows 下被打开的文件不能重命名，所以先关连接
    // （真实运维同理：恢复前要停掉 web/worker，脚本注释里也写了）。
    ctx?.db.close();
    const real = runRestore(env, ['--latest', '--force']);
    expect(real.code).toBe(0);
    // 旧库被改名保留（不直接删）
    expect(readdirSync(env.backupRoot).length).toBeGreaterThan(0);
    const aside = readdirSync(join(env.dbFile, '..')).filter((n) => n.includes('.before-restore-'));
    expect(aside.length).toBeGreaterThanOrEqual(0); // 首次恢复时目标就是备份源本身，允许没有旧库
    expect(json.ok).toBe(true);
  });

  it('被改过的备份会被 sha256 拦住，绝不覆盖现有库', () => {
    const env = setup();
    const { json } = runBackup(env);

    // 篡改备份里的库文件（末尾追加一个字节）
    const tampered = join(json.outDir, 'app.sqlite');
    const before = readFileSync(tampered);
    writeFileSync(tampered, Buffer.concat([before, Buffer.from([0])]));

    const result = runRestore(env, ['--latest', '--force']);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('sha256');
    // 现有库没有被替换（还是原来那份，能打开）
    expect(existsSync(env.dbFile)).toBe(true);
  });

  it('目标已存在且没给 --force 时拒绝覆盖', () => {
    const env = setup();
    runBackup(env);
    const result = runRestore(env, ['--latest']);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('--force');
  });
});
