/**
 * 迁移执行器的两条能力测试 + 一条防漂移断言。
 *
 * 1. **普通迁移失败必须整体回滚**（不能留半成品）——这是既有行为，用测试钉住；
 * 2. **声明 `-- dsh:migration-transaction=off` 的迁移可以重建被外键引用的表**：
 *    SQLite 改不了 CHECK，只能重建；而重建要关外键，`PRAGMA foreign_keys` 在事务里是空操作，
 *    所以这条能力是"能不能扩展 CHECK 约束"的前提（0007 就靠它）；
 * 3. **数据库的 `task_type` CHECK 必须与代码里的 `TaskTypes` 逐条一致** ——
 *    两份清单分居迁移与代码里，最容易一边加了另一边忘了。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from '@/server/platform/migrate';
import { openDatabase } from '@/server/platform/db';
import { TaskTypes } from '@/packages/common/field-rules';
import { createTestDb } from './support/db';

/** 造一个只含给定迁移文件的临时目录。 */
function migrationsDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function tempDbFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-migdb-')), 'app.sqlite');
}

describe('迁移执行器：事务语义', () => {
  it('普通迁移执行到一半失败 → 整个文件回滚，不留半成品，也不记版本', () => {
    const file = tempDbFile();
    const db = openDatabase({ file });
    const dir = migrationsDirWith({
      '0001_broken.sql': `
        CREATE TABLE 已经建好的表 (id TEXT PRIMARY KEY);
        CREATE TABLE 语法坏掉的表 (id TEXT PRIMARY KEY, x TEXT NOT NULL CHECK (x IN (1);
      `,
    });

    expect(() => migrate({ db, migrationsDir: dir })).toThrow();

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toContain('schema_migrations'); // 登记表由执行器自己建
    expect(tables).not.toContain('已经建好的表'); // 同文件里先成功的语句也要回滚
    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map(
      (v) => v.version,
    );
    expect(versions).toEqual([]);
    db.close();
  });

  it('声明 no-transaction 的迁移能重建被外键引用的表，且数据与外键完整性都保住', () => {
    const file = tempDbFile();
    const db = openDatabase({ file });

    // 0001：父表 + 子表（外键指向父表），并塞一行数据
    const dir = migrationsDirWith({
      '0001_base.sql': `
        CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a')));
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
        INSERT INTO parent (id, kind) VALUES ('p1', 'a');
        INSERT INTO child (id, parent_id) VALUES ('c1', 'p1');
      `,
      // 0002：把 parent 的 CHECK 扩成 ('a','b') —— 只能重建，且必须先关外键
      '0002_rebuild.sql': `-- dsh:migration-transaction=off
        PRAGMA foreign_keys = OFF;
        BEGIN;
        CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a','b')));
        INSERT INTO parent_new (id, kind) SELECT id, kind FROM parent;
        DROP TABLE parent;
        ALTER TABLE parent_new RENAME TO parent;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `,
    });

    const result = migrate({ db, migrationsDir: dir });
    expect(result.applied).toEqual(['0001_base.sql', '0002_rebuild.sql']);

    // 数据保住
    expect(db.prepare('SELECT id, kind FROM parent').all()).toEqual([{ id: 'p1', kind: 'a' }]);
    expect(db.prepare('SELECT id, parent_id FROM child').all()).toEqual([{ id: 'c1', parent_id: 'p1' }]);
    // 外键完整性干净（重建过程中没有把引用弄坏）
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // 新 CHECK 真的生效了：'b' 允许，'c' 不许
    db.pragma('foreign_keys = ON');
    expect(() => db.prepare("INSERT INTO parent (id, kind) VALUES ('p2','b')").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO parent (id, kind) VALUES ('p3','c')").run()).toThrow(/CHECK/);
    db.close();
  });
});

describe('任务类型清单不许漂移', () => {
  it('数据库 task_type 的 CHECK 与 field-rules 的 TaskTypes 逐条一致', () => {
    const ctx = createTestDb();
    try {
      const row = ctx.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'background_tasks'")
        .get() as { sql: string };
      const m = /task_type\s+IN\s*\(([^)]*)\)/.exec(row.sql);
      expect(m).not.toBeNull();
      const inDb = (m as RegExpExecArray)[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s.length > 0);
      expect(inDb).toEqual([...TaskTypes]);
    } finally {
      ctx.cleanup();
    }
  });
});
