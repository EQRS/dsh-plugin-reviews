// 独立复核 gf-platform 报告的 Node cpSync 崩溃：确认是否为环境事实。
// 注意：本脚本刻意在纯 ASCII 的临时路径下运行，避免用本项目路径触发崩溃。
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = join(tmpdir(), `cp-verify-${Date.now()}`);
mkdirSync(base, { recursive: true });

function probe(label, srcDirName, { cjk = false, recursive = true, asFile = false } = {}) {
  const srcName = cjk ? `${srcDirName}-中文源` : `${srcDirName}-ascii`;
  const src = join(base, srcName);
  const dst = join(base, `${srcName}-dst`);
  if (asFile) {
    const f = `${src}.txt`;
    const script = `require('node:fs').writeFileSync(${JSON.stringify(f)},'x');require('node:fs').cpSync(${JSON.stringify(f)},${JSON.stringify(dst + '.txt')},{recursive:${recursive}});console.log('OK')`;
    return run(label, script);
  }
  mkdirSync(src, { recursive: true });
  const script = `require('node:fs').cpSync(${JSON.stringify(src)},${JSON.stringify(dst)},{recursive:${recursive}});console.log('OK')`;
  return run(label, script);
}

function run(label, script) {
  try {
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: 'pipe' });
    console.log(`${label}: OK (${out.trim()})`);
  } catch (e) {
    const status = e.status;
    const verdict = status === -1073740791 ? '硬崩 0xC0000409' : `失败 status=${status}`;
    console.log(`${label}: ${verdict}`);
  }
}

probe('A CJK 目录 + recursive', 'a', { cjk: true, recursive: true });
probe('B ASCII 目录 + recursive (控制组)', 'b', { cjk: false, recursive: true });
probe('C CJK 目录 + recursive:false', 'c', { cjk: true, recursive: false });
probe('D CJK 文件 + recursive', 'd', { cjk: true, asFile: true });

rmSync(base, { recursive: true, force: true });
console.log(`cleanup ok: ${!existsSync(base)}`);
