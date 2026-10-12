// 快速核对迁移能否干净应用（本地诊断用，不属于产品代码）。
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
const dir = join(process.cwd(), 'migrations');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  try {
    db.exec(readFileSync(join(dir, f), 'utf8'));
    console.log(`${f} OK`);
  } catch (e) {
    console.log(`${f} FAIL: ${e.message}`);
    process.exit(1);
  }
}
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`tables(${tables.length}): ${tables.join(', ')}`);
console.log(`triggers: ${db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='trigger'").get().c}`);
console.log(`fk_check: ${JSON.stringify(db.pragma('foreign_key_check'))}`);
