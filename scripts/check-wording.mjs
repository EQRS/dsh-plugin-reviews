/**
 * 测评用词检查（docs/用词规范.md 的可执行版）。
 *
 * 为什么要有它：
 *   规范写在文档里，人不会每次照做；把禁词变成一条能跑的命令，才能当门禁。
 *
 * 检查分两级：
 *   error   —— 专有词与英文禁用词（对照 docs/用词规范.md 第二、三节）
 *   warning —— 程度/肯定/夸张/语气/推测类修饰词（第四节）；单字「很/更/太/挺/蛮」不查，
 *              误报率高（「更新」「更多」不是程度状语）。
 *
 * 不算命中的地方（规范第三、四节的例外）：
 *   代码块、行内代码、网址、插件名（含 dsh- 前缀或带点号的包名）、版本号、命令。
 *
 * 用法：
 *   node scripts/check-wording.mjs docs/用词规范.md
 *   node scripts/check-wording.mjs            # 默认扫 docs/ 下的 .md
 * 退出码：0 无 error；1 有 error（warning 不影响退出码，除非加 --strict）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/** 第二节：专有词替换表。左边一律不用。 */
export const NOUN_REPLACEMENTS = Object.freeze({
  范式: '做法',
  契约: '要求',
  闸门: '限制',
  门槛: '限制',
  证据链: '能点开的记录',
  配对对照: '一组装、一组不装，做同样的事',
  统计判定: '按次数比',
  渐进披露: '先给一点，再给更多',
  鉴权: '身份检查',
  闭环: '写完能读回',
  飞轮: '反复积累',
  口径: '标准',
  档位: '等级',
  落盘: '存到本地',
  开箱: '装完就能用',
  生态: '插件圈',
  元认知: '自我检查',
  归因: '找原因',
  维度: '方面',
  召回: '找回来',
  注入: '塞进对话',
  上下文: '对话内容',
});

/** 第三节：英文禁用词。例外词（插件名/版本/命令/网址）在 parseLine 里整段跳过。 */
export const ENGLISH_REPLACEMENTS = Object.freeze({
  Node: '运行环境',
  npm: '安装工具',
  API: '网页接口',
  HTTP: '网页请求',
  SQLite: '本地数据库',
  MIT: '开源许可',
  BSD: '开源许可',
  Apache: '开源许可',
  beta: '测试版',
  rc: '测试版',
  issue: '问题',
  tag: '版本标记',
  commit: '提交记录',
  release: '发布页',
  profile: '配置',
  demo: '演示',
  star: '星',
});

/** 第四节：修饰词（只收误报率低的，warning 级）。 */
export const MODIFIERS = Object.freeze([
  '非常', '十分', '极其', '特别', '相当', '确实', '真的', '实在', '的确', '明明',
  '大幅', '显著', '彻底', '完全', '几乎', '基本上', '其实', '竟然', '居然', '简直',
  '大概', '也许', '似乎', '好像', '恐怕',
]);

/** 例外：插件名、版本号、命令、网址、被测对象。 */
const EXCEPTION_PATTERNS = [
  /https?:\/\/[^\s)）]+/g,                       // 网址
  /[\w@./-]*dsh-[\w-]+/g,                          // 插件名 dsh-xxx
  /@[\w-]+\/[\w-]+/g,                             // 带作用域的包名
  /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g,      // 版本号
  /--[a-z][a-z-]*/g,                                 // 命令参数名：--profile 这类不是文案
  /\bdsh\b|\bDSH\b|\bDeepSeek\b/g,                // 被测对象名
];

function stripExceptions(text) {
  let out = text;
  for (const re of EXCEPTION_PATTERNS) out = out.replace(re, ' ');
  return out;
}

/** 去掉代码块与行内代码，保留行数（换行照旧），便于报行号。 */
export function stripCodeBlocks(text) {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return '';
      }
      if (inFence) return '';
      return line.replace(/`[^`]*`/g, ' ');
    })
    .join('\n');
}

/**
 * 检查一段文本。
 * @returns {{line:number, rule:'noun'|'english'|'modifier', word:string, suggestion:string, severity:'error'|'warning'}[]}
 */
export function checkText(text) {
  const cleaned = stripExceptions(stripCodeBlocks(text));
  const hits = [];
  cleaned.split('\n').forEach((line, i) => {
    for (const [word, suggestion] of Object.entries(NOUN_REPLACEMENTS)) {
      if (line.includes(word)) hits.push({ line: i + 1, rule: 'noun', word, suggestion, severity: 'error' });
    }
    for (const [word, suggestion] of Object.entries(ENGLISH_REPLACEMENTS)) {
      const re = new RegExp('\\b' + word + '\\b');
      if (re.test(line)) hits.push({ line: i + 1, rule: 'english', word, suggestion, severity: 'error' });
    }
    for (const word of MODIFIERS) {
      if (line.includes(word)) hits.push({ line: i + 1, rule: 'modifier', word, suggestion: '删掉，或换成具体读数', severity: 'warning' });
    }
  });
  return hits;
}

/** 整个文件跳过检查的标记（写在文件任意位置即可）。 */
export const FILE_ALLOW_MARKER = '<!-- wording-allow-file -->';

/** 检查若干文件；带豁免标记的文件跳过。 */
export function checkFiles(paths) {
  const results = [];
  for (const file of paths) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(FILE_ALLOW_MARKER)) {
      results.push({ file, hits: [], skipped: true });
      continue;
    }
    results.push({ file, hits: checkText(text), skipped: false });
  }
  return results;
}

function collectMarkdown(target) {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target)
    .filter((name) => extname(name) === '.md')
    .map((name) => join(target, name));
}

function main(argv) {
  const strict = argv.includes('--strict');
  const targets = argv.filter((a) => !a.startsWith('--'));
  if (!targets.length) {
    console.error('用词检查只对「对外文字」生效，请指明要查的文件或目录。');
    console.error('用法：node scripts/check-wording.mjs <文件或目录> [--strict]');
    console.error('例：node scripts/check-wording.mjs docs/用词规范.md');
    console.error('技术文档（接口清单、部署说明）不在适用范围内；如确需一并检查，加 --force。');
    return 2;
  }
  const files = targets.flatMap(collectMarkdown);
  if (!files.length) {
    console.error('目标目录里没有 .md 文件。');
    return 2;
  }

  let errors = 0;
  let warnings = 0;
  for (const result of checkFiles(files)) {
    for (const hit of result.hits) {
      const where = `${result.file}:${hit.line}`;
      const label = hit.severity === 'error' ? 'ERROR' : 'WARN ';
      console.log(`${label} ${where}  「${hit.word}」→ ${hit.suggestion}`);
      if (hit.severity === 'error') errors += 1;
      else warnings += 1;
    }
  }

  console.log(`\n检查 ${files.length} 个文件：error ${errors} 条，warning ${warnings} 条。`);
  if (errors > 0) return 1;
  if (strict && warnings > 0) return 1;
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-wording.mjs');
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
