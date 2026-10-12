// 反恒真自检（文件存储）：去掉路径穿越防护，测试**必须**变红。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const target = join(root, 'src', 'server', 'platform', 'file-store.ts');
const backup = join(root, '.data', 'file-store.bak');

const original = readFileSync(target, 'utf8');

// 破坏 1：让 assertSafeStorageKey 变成空操作（等于放弃防护）
const broken = original.replace(
  /export function assertSafeStorageKey\(storageKey: string\): void \{[\s\S]*?\n\}/,
  'export function assertSafeStorageKey(storageKey: string): void {\n  void storageKey; // [反恒真自检] 故意移除所有校验\n}',
);
if (broken === original) {
  console.error('自检失败：没能定位 assertSafeStorageKey，请检查文件结构。');
  process.exit(2);
}

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/file-store.test.ts'], { cwd: root, stdio: 'pipe', shell: true });
    return true;
  } catch {
    return false;
  }
}

try {
  copyFileSync(target, backup);
  writeFileSync(target, broken, 'utf8');

  if (runTests()) {
    console.error('❌ 反恒真自检失败：去掉路径防护后测试仍通过 —— 说明防护测试是恒真的。');
    process.exit(1);
  }
  console.log('✅ 步骤 1：移除 assertSafeStorageKey 校验体 → 防护测试如期变红。');
} finally {
  copyFileSync(backup, target);
  unlinkSync(backup);
}

// 逐字节回读，确认还原干净（不接受"看起来还原了"）
const restored = readFileSync(target, 'utf8');
if (restored !== original) {
  console.error('❌ 还原不干净：文件与原始内容不一致。');
  process.exit(1);
}
console.log('✅ 步骤 2：还原后逐字节核对一致。');

if (!runTests()) {
  console.error('❌ 还原后测试仍失败，请检查仓库状态。');
  process.exit(1);
}
console.log('✅ 步骤 3：还原后测试重新通过。');
console.log('\n结论：文件存储的路径穿越防护测试确实在咬人。');
