/**
 * 备份（`参数与管理规则.md §81`：每日 03:00 一个完整恢复点 + 管理员可立即备份）。
 *
 * GET  /api/admin/backups   最近备份清单（读各份的 manifest，不读库）
 * POST /api/admin/backups   立即备份一份（同步跑，库只有几 MB 时是毫秒级）
 *
 * 实现刻意**复用同一个 CLI**（`scripts/backup.mjs`）：定时任务、后台按钮、人工排查
 * 走的是同一份逻辑。备份这种"平时不跑、出事才跑"的东西，最怕有第二套实现悄悄漂移。
 *
 * 权限：每次从库里读角色（不缓存），非管理员 403。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

/** 与 scripts/backup.mjs 的默认值保持一致（宿主 backup 没有这条时用同级 backups/）。 */
function backupRoot(): string {
  const configured = process.env.BACKUP_ROOT?.trim();
  if (configured) return resolve(configured);
  const dbPath = resolve(process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite');
  return resolve(join(dirname(dbPath), '..', 'backups'));
}

interface BackupSummary {
  dirName: string;
  createdAt: string | null;
  label: string | null;
  schemaVersion: string | null;
  counts: Record<string, number | null>;
  dbBytes: number | null;
  integrity: string | null;
  integrityOk: boolean | null;
  hasMedia: boolean;
  dirBytes: number | null;
}

function listBackups(root: string): BackupSummary[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^\d{8}-\d{9}-[a-z0-9-]+$/.test(name))
    .sort()
    .reverse()
    .slice(0, 20)
    .map((dirName) => {
      const dir = join(root, dirName);
      let manifest: Record<string, unknown> | null = null;
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      } catch {
        manifest = null;
      }
      return {
        dirName,
        createdAt: (manifest?.createdAt as string) ?? null,
        label: (manifest?.label as string) ?? null,
        schemaVersion: (manifest?.schemaVersion as string) ?? null,
        counts: (manifest?.counts as Record<string, number | null>) ?? {},
        dbBytes: (manifest?.dbBytes as number) ?? null,
        integrity: (manifest?.integrity as string) ?? null,
        integrityOk: (manifest?.integrityOk as boolean) ?? null,
        hasMedia: existsSync(join(dir, 'media.tar.gz')),
        dirBytes: null,
      };
    });
}

/** 同一个进程里只允许一份备份在跑（两个管理员同时点，不该并发写同一个目录）。 */
let running = false;

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
    getDb(); // 顺手确认库可用（挂了的话这条接口也该明确报错，而不是返回空清单）

    const root = backupRoot();
    const backups = listBackups(root);
    return okJson(
      {
        backupRoot: root,
        keep: Number(process.env.BACKUP_KEEP ?? 14),
        backups,
        lastBackupAt: backups[0]?.createdAt ?? null,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
    if (running) throw err.conflict('已经有一份备份在进行中，请稍后刷新。');

    running = true;
    try {
      const keep = Number(process.env.BACKUP_KEEP ?? 14);
      const raw = execFileSync(
        process.execPath,
        [join(process.cwd(), 'scripts', 'backup.mjs'), '--json', '--label', 'manual', '--keep', String(keep)],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, BACKUP_ROOT: backupRoot() },
          timeout: 120_000,
        },
      );
      const result = JSON.parse(raw) as { ok: boolean; outDir: string; manifest: Record<string, unknown> };
      return okJson(
        {
          ok: result.ok,
          dir: result.outDir,
          createdAt: result.manifest?.createdAt ?? null,
          schemaVersion: result.manifest?.schemaVersion ?? null,
          counts: result.manifest?.counts ?? {},
          dbBytes: result.manifest?.dbBytes ?? null,
          durationMs: result.manifest?.durationMs ?? null,
        },
        requestId,
        201,
      );
    } finally {
      running = false;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
