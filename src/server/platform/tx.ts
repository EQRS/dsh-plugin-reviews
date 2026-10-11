/**
 * 事务封装（架构第 67.3 节）。
 *
 * 规则：
 *  - 跨模块流程创建**一次短事务**，参与模块共用同一受限事务上下文；
 *  - 不得各自提交独立事务后假装整体原子成功；
 *  - 外部拉取、Markdown 解析、图片处理、文件复制一律在事务之外完成；
 *  - 页面与 HTTP 入口不能自行指定连接或事务对象。
 */

import type { SqliteDatabase } from './db';
import { getDb } from './db';

/** 受限事务上下文：模块只能拿它做语句执行，不能拿它开并发事务。 */
export interface Tx {
  readonly db: SqliteDatabase;
  /** 已提交/回滚标记，防止事务结束后继续写入。 */
  readonly finished: boolean;
}

function makeTx(db: SqliteDatabase): Tx & { markFinished: () => void } {
  const state = { finished: false };
  return {
    get db() {
      if (state.finished) throw new Error('事务已结束：禁止在事务外继续使用该上下文');
      return db;
    },
    get finished() {
      return state.finished;
    },
    markFinished() {
      state.finished = true;
    },
  };
}

/**
 * 执行一次写事务。
 * better-sqlite3 的事务函数是同步的；传入的回调**必须是同步函数**，
 * 异步副作用（网络、文件）请在调用本函数之前准备好。
 */
export function withTransaction<T>(fn: (tx: Tx) => T, db: SqliteDatabase = getDb()): T {
  const runner = db.transaction(() => {
    const tx = makeTx(db);
    try {
      return fn(tx);
    } finally {
      tx.markFinished();
    }
  });
  return runner() as T;
}

/** 读操作：不进入写事务，直接使用连接。 */
export function withRead<T>(fn: (db: SqliteDatabase) => T, db: SqliteDatabase = getDb()): T {
  return fn(db);
}
