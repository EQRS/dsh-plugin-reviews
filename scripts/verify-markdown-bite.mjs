// 反恒真自检（Markdown 净化）：去掉 rehype-sanitize，XSS 用例必须变红。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const target = join(root, 'src', 'server', 'platform', 'markdown.ts');
const backup = join(root, '.data', 'markdown.bak');
const original = readFileSync(target, 'utf8');

// 破坏：把 sanitize 从管线里摘掉（等于原样输出用户 HTML）
const broken = original.replace('  .use(rehypeSanitize, schema)\n', '  // [反恒真自检] 故意移除净化步骤\n');
if (broken === original) {
  console.error('自检失败：没能在管线里定位 rehypeSanitize，请检查文件结构。');
  process.exit(2);
}

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/markdown.test.ts'], { cwd: root, stdio: 'pipe', shell: true });
    return true;
  } catch {
    return false;
  }
}

try {
  copyFileSync(target, backup);
  writeFileSync(target, broken, 'utf8');
  if (runTests()) {
    console.error('❌ 反恒真自检失败：移除净化后 XSS 测试仍通过 —— 说明净化测试是恒真的。');
    process.exit(1);
  }
  console.log('✅ 步骤 1：移除 rehype-sanitize → XSS 测试如期变红。');
} finally {
  copyFileSync(backup, target);
  unlinkSync(backup);
}

if (readFileSync(target, 'utf8') !== original) {
  console.error('❌ 还原不干净：文件与原始内容不一致。');
  process.exit(1);
}
console.log('✅ 步骤 2：还原后逐字节核对一致。');

if (!runTests()) {
  console.error('❌ 还原后测试仍失败。');
  process.exit(1);
}
console.log('✅ 步骤 3：还原后测试重新通过。');
console.log('\n结论：Markdown 净化测试确实在咬人。');
