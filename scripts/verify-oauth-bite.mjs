// 反恒真自检（OAuth）：分别破坏「state 摘要比对」「一次性消费」「过期判断」，测试必须变红。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const target = join(root, 'src', 'server', 'modules', 'identity', 'oauth-challenges.ts');
const backup = join(root, '.data', 'oauth-challenges.bak');
const original = readFileSync(target, 'utf8');

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/oauth.test.ts'], { cwd: root, stdio: 'pipe', shell: true });
    return true;
  } catch {
    return false;
  }
}

function tryBreak(name, mutate) {
  const broken = mutate(original);
  if (broken === original) {
    console.error(`自检失败：没能定位「${name}」对应代码。`);
    process.exit(2);
  }
  try {
    copyFileSync(target, backup);
    writeFileSync(target, broken, 'utf8');
    if (runTests()) {
      console.error(`❌ 反恒真自检失败：「${name}」被破坏后测试仍通过。`);
      process.exit(1);
    }
    console.log(`✅ ${name}：破坏后测试如期变红。`);
  } finally {
    copyFileSync(backup, target);
    unlinkSync(backup);
  }
  if (readFileSync(target, 'utf8') !== original) {
    console.error('❌ 还原不干净。');
    process.exit(1);
  }
}

// 破坏 1：不再比对浏览器绑定摘要
tryBreak('浏览器绑定比对', (src) =>
  src.replace(
    /if \(row\.browser_binding_digest !== digestText\(input\.browserBinding\)\) \{[\s\S]*?\n        \}/,
    '// [反恒真自检] 不再比对浏览器绑定',
  ),
);

// 破坏 2：一次性消费失效。
// 注意：重放由**两层**防护拦下 —— ① consumed_at 预检查；② UPDATE 的
// `WHERE consumed_at IS NULL` 条件更新（真正的原子保护）。
// 只破坏①测试不会变红（②仍然拦住），这是正确的纵深防御，不是测试缺陷。
// 因此这里破坏的是**真正的强制点**：条件更新的 WHERE 子句。
tryBreak('一次性消费（原子条件更新）', (src) =>
  src.replace(
    "UPDATE oauth_login_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
    'UPDATE oauth_login_challenges SET consumed_at = ? WHERE id = ?',
  ),
);

// 破坏 3：不再判断过期
tryBreak('过期判断', (src) =>
  src.replace(
    /if \(row\.expires_at <= now\) \{[\s\S]*?\n        \}/,
    '// [反恒真自检] 不再判断过期',
  ),
);

if (!runTests()) {
  console.error('❌ 还原后测试仍失败。');
  process.exit(1);
}
console.log('✅ 三项破坏均已还原，测试重新通过。');
console.log('\n结论：OAuth 挑战的安全测试确实在咬人。');
