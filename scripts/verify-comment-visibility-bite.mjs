// 反恒真自检（评论可见性）：把过滤条件去掉，回归测试**必须**变红。
// 用法：node scripts/verify-comment-visibility-bite.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const target = join(root, 'src', 'server', 'modules', 'comments', 'index.ts');
const backup = join(root, '.data', 'comments-index.bak');

const original = readFileSync(target, 'utf8');

// 破坏：去掉顶层评论的公开修订过滤
const broken = original.replace('AND published_revision_id IS NOT NULL', '');
if (broken === original) {
  console.error('自检失败：没找到 published_revision_id 过滤条件，迁移文件结构可能已变。');
  process.exit(2);
}

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/comments-visibility.test.ts'], { cwd: root, stdio: 'pipe', shell: true });
    return true;
  } catch {
    return false;
  }
}

try {
  copyFileSync(target, backup);
  writeFileSync(target, broken, 'utf8');

  if (runTests()) {
    console.error('❌ 反恒真自检失败：去掉公开修订过滤后测试仍通过 —— 说明该测试是恒真的。');
    process.exit(1);
  }
  console.log('✅ 步骤 1：去掉 published_revision_id 过滤 → 评论可见性测试如期变红。');
} finally {
  copyFileSync(backup, target);
  unlinkSync(backup);
}

// 回读校验：确认还原干净（不能只信 exit code）
const restored = readFileSync(target, 'utf8');
if (restored !== original) {
  console.error('❌ 还原不干净：文件与原始内容不一致，请手工检查 ' + target);
  process.exit(1);
}
console.log('✅ 步骤 2：还原后逐字节核对一致。');

if (!runTests()) {
  console.error('❌ 还原后测试仍失败，请检查仓库状态。');
  process.exit(1);
}
console.log('✅ 步骤 3：还原后测试重新通过。');
console.log('\n结论：评论可见性测试确实在咬人。');
