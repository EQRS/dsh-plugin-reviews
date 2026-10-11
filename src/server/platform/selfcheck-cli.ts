import { getDb } from './db';
import { selfCheck } from './migrate';

const db = getDb();
const result = selfCheck(db);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
