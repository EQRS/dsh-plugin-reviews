// 反恒真自检：故意破坏约束，测试**必须**变红。
// 用法：node scripts/verify-tests-bite.mjs
//
// 做两件事：
//   1. 备份 migrations/0002_triggers.sql，删掉盖楼触发器，跑约束测试 → 期望失败；
//   2. 恢复文件，再跑一次 → 期望通过。
// 任一环节不符合预期就以非零退出，并把原因打印出来。

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const triggers = join(root, 'migrations', '0002_triggers.sql');
const backup = join(root, '.data', '0002_triggers.sql.bak');

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/constraints.test.ts'], {
      cwd: root,
      stdio: 'pipe',
      shell: true,
    });
    return true; // 通过
  } catch {
    return false; // 失败
  }
}

const original = readFileSync(triggers, 'utf8');

// --- 步骤 1：删掉盖楼触发器，期望测试失败 ---
const broken = original.replace(
  /CREATE TRIGGER trg_comments_reply_group_insert[\s\S]*?END;/,
  '-- [反恒真自检] 故意移除盖楼触发器',
);
if (broken === original) {
  console.error('自检失败：没能定位到 trg_comments_reply_group_insert，请检查迁移文件结构。');
  process.exit(2);
}

try {
  copyFileSync(triggers, backup);
  writeFileSync(triggers, broken, 'utf8');

  const passedWhenBroken = runTests();
  if (passedWhenBroken) {
    console.error('❌ 反恒真自检失败：删掉盖楼触发器后测试仍然通过 —— 说明测试是恒真的。');
    process.exit(1);
  }
  console.log('✅ 步骤 1：删掉盖楼触发器 → 测试如期变红（测试确实在咬人）。');
} finally {
  copyFileSync(backup, triggers);
  unlinkSync(backup);
}

// --- 步骤 2：恢复后应重新通过 ---
if (!runTests()) {
  console.error('❌ 恢复迁移文件后测试仍失败，请检查仓库状态。');
  process.exit(1);
}
console.log('✅ 步骤 2：恢复迁移文件 → 测试重新通过。');
console.log('\n结论：约束测试不是恒真断言。');
