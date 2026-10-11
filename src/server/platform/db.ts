/**
 * 数据库连接工厂（依赖与 Linux 部署第 4 节 / 架构第 5、6 节）。
 *
 * 全站唯一连接入口。规则：
 *  - 事务外启用 `PRAGMA foreign_keys = ON`（绝不允许关闭外键换取写入顺序）；
 *  - 采用 WAL；`busy_timeout` 默认 5000ms；
 *  - better-sqlite3 是同步驱动，等待会阻塞所属线程，因此业务事务保持短小，
 *    不在事务内做网络请求、图片处理或 Markdown 解析。
 *
 * ⚠ 并行纪律：本文件由「基础组」拥有，其他模块不得自行 `new Database(...)`。
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export type SqliteDatabase = Database.Database;

export interface OpenOptions {
  /** 数据库文件路径；`:memory:` 仅用于工具与自检，业务测试必须用真实文件。 */
  file: string;
  /** 只读连接（公开查询可用，避免误写）。 */
  readonly?: boolean;
  /** 默认 5000ms。 */
  busyTimeoutMs?: number;
}

let singleton: SqliteDatabase | null = null;
let singletonFile: string | null = null;

/** 解析数据库文件路径：相对路径基于工作目录，目录不存在则创建。 */
export function resolveDbPath(file: string | undefined | null): string {
  const raw = file ?? process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite';
  if (raw === ':memory:') return raw;
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

/**
 * 打开连接并完成必备 PRAGMA。
 * 调用方负责关闭（进程级单例请用 getDb）。
 */
export function openDatabase(options: OpenOptions): SqliteDatabase {
  const db = new Database(options.file, { readonly: options.readonly ?? false });

  // 外键：每个连接都必须启用，且在事务外执行。
  db.pragma('foreign_keys = ON');
  // 延迟外键让「公共实体 + 具体子类型」可以在同一事务任意顺序插入，commit 时统一校验。
  db.pragma('defer_foreign_keys = ON');

  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);

  const fk = db.pragma('foreign_keys', { simple: true });
  if (fk !== 1) {
    db.close();
    throw new Error('外键未被启用：拒绝在 foreign_keys 关闭的连接上工作');
  }
  return db;
}

/** 进程级单例连接（Web 与 worker 各自一个进程）。 */
export function getDb(): SqliteDatabase {
  const file = resolveDbPath(process.env.DSH_REVIEW_DB_PATH);
  if (singleton && singletonFile === file) return singleton;
  if (singleton) singleton.close();
  singleton = openDatabase({ file });
  singletonFile = file;
  return singleton;
}

/** 测试与维护入口：关闭单例。 */
export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
    singletonFile = null;
  }
}
