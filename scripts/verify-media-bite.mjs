// 反恒真自检（媒体）：分别破坏「真实格式鉴定」与「读取权限」，测试必须变红。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const target = join(root, 'src', 'server', 'modules', 'media', 'service.ts');
const backup = join(root, '.data', 'media-service.bak');
const original = readFileSync(target, 'utf8');

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/media.test.ts'], { cwd: root, stdio: 'pipe', shell: true });
    return true;
  } catch {
    return false;
  }
}

function tryBreak(name, mutate) {
  const broken = mutate(original);
  if (broken === original) {
    console.error(`自检失败：没能定位「${name}」对应的代码，请检查文件结构。`);
    process.exit(2);
  }
  try {
    copyFileSync(target, backup);
    writeFileSync(target, broken, 'utf8');
    if (runTests()) {
      console.error(`❌ 反恒真自检失败：「${name}」被破坏后测试仍通过 —— 该测试是恒真的。`);
      process.exit(1);
    }
    console.log(`✅ ${name}：破坏后测试如期变红。`);
  } finally {
    copyFileSync(backup, target);
    unlinkSync(backup);
  }
  // 逐字节回读还原结果
  if (readFileSync(target, 'utf8') !== original) {
    console.error('❌ 还原不干净：文件与原始内容不一致。');
    process.exit(1);
  }
}

// 破坏 1：真实格式鉴定降级为"只看是否非空"（等于放弃鉴图）
tryBreak('真实格式鉴定', (src) =>
  src.replace(
    /let meta: SharpMetadata;\n  try \{\n    meta = await sharp\(bytes, \{ failOn: 'error' \}\)\.metadata\(\);\n  \} catch \{[\s\S]*?\n  \}/,
    "const meta: SharpMetadata = { format: 'png', width: 1, height: 1 }; // [反恒真自检] 不再真实解码",
  ),
);

// 破坏 2：去掉读取权限判断（任何 ready 文件都可被匿名读取）
tryBreak('读取权限', (src) =>
  src.replace(
    /const isOwner = viewer\.userId !== null && viewer\.userId === ownerOf\(conn, input\.attachmentId\);\n        if \(isOwner\) \{[\s\S]*?\n        \}\n        if \(file\.variant_role !== 'display'\) return null;\n        if \(!isPubliclyReferenced\(conn, file\.id\)\) return null;\n        return \{ storageKey: file\.storage_key, mime: file\.mime_type \};/,
    "// [反恒真自检] 去掉全部权限判断\n        return { storageKey: file.storage_key, mime: file.mime_type };",
  ),
);

if (!runTests()) {
  console.error('❌ 还原后测试仍失败，请检查仓库状态。');
  process.exit(1);
}
console.log('✅ 两项破坏均已还原，测试重新通过。');
console.log('\n结论：媒体的鉴图与权限测试确实在咬人。');
