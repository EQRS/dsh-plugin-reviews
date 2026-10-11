import { migrate } from './migrate';
import { resolveDbPath, closeDb } from './db';

const result = migrate();
console.log(
  JSON.stringify(
    {
      database: result.databaseFile,
      applied: result.applied,
      alreadyApplied: result.alreadyApplied,
      foreignKeyCheck: result.foreignKeyCheck,
    },
    null,
    2,
  ),
);

if (result.foreignKeyCheck.length > 0) {
  console.error('迁移后 foreign_key_check 报出不一致，请检查。');
  closeDb();
  process.exit(1);
}
console.log(`数据库就绪：${resolveDbPath(process.env.DSH_REVIEW_DB_PATH)}`);
closeDb();
