/**
 * 用词检查测试（docs/用词规范.md 的执行版）。
 *
 * 每条用例都必须在规则被破坏时变红：
 *  - 从 NOUN_REPLACEMENTS 里删一条 → 对应用例失败；
 *  - 去掉 stripCodeBlocks → 代码块用例失败；
 *  - 把 severity 从 error 改成 warning → 分级用例失败。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkText,
  checkFiles,
  FILE_ALLOW_MARKER,
  NOUN_REPLACEMENTS,
  ENGLISH_REPLACEMENTS,
  MODIFIERS,
} from '../scripts/check-wording.mjs';

function words(text: string): string[] {
  return checkText(text).map((h) => h.word);
}

describe('专有词（error）', () => {
  it('替换表里的词都会被抓到，并给出替换说法', () => {
    const hits = checkText('这条证据链很清楚，我们做了配对对照。');
    expect(hits.some((h) => h.word === '证据链' && h.suggestion === '能点开的记录')).toBe(true);
    expect(hits.some((h) => h.word === '配对对照')).toBe(true);
    expect(hits.every((h) => h.severity === 'error')).toBe(true);
  });

  it('替换表本身不为空，且每条都有中文替换说法', () => {
    const entries = Object.entries(NOUN_REPLACEMENTS);
    expect(entries.length).toBeGreaterThan(10);
    for (const [, suggestion] of entries) {
      expect(typeof suggestion).toBe('string');
      expect(/[\u4e00-\u9fa5]/.test(suggestion)).toBe(true);
    }
  });

  it('报出行号，便于定位', () => {
    const hits = checkText('第一行没问题\n第二行有证据链');
    expect(hits[0].line).toBe(2);
  });
});

describe('英文（error）', () => {
  it('禁用英文按词边界命中', () => {
    expect(words('用 Node 跑，再用 npm 装')).toEqual(expect.arrayContaining(['Node', 'npm']));
    expect(checkText('API 与 HTTP 都不写').map((h) => h.word)).toEqual(expect.arrayContaining(['API', 'HTTP']));
  });

  it('例外五项不命中：插件名 / 版本号 / 命令 / 被测对象 / 网址', () => {
    const text = [
      '装 dsh-memory 0.9.8：dsh plugin --profile web add dsh-memory',
      '站点在 review.lingshulab.com，被测对象是 DSH 和 DeepSeek。',
      '带作用域的包名 @hyzyn/dsh-rss 也放过。',
    ].join('\n');
    expect(words(text)).toEqual([]);
  });

  it('英文表每条都有中文替换说法', () => {
    for (const [word, suggestion] of Object.entries(ENGLISH_REPLACEMENTS)) {
      expect(word.length).toBeGreaterThan(0);
      expect(/[\u4e00-\u9fa5]/.test(suggestion)).toBe(true);
    }
  });
});

describe('修饰词（warning）', () => {
  it('程度与肯定类给出 warning，不阻断', () => {
    const hits = checkText('这个插件确实非常快。');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.severity === 'warning')).toBe(true);
    expect(hits.map((h) => h.word)).toEqual(expect.arrayContaining(['确实', '非常']));
  });

  it('单字「很/更/太」不查，避免误报「更新」「更多」', () => {
    expect(words('更新更多功能，太阳很大')).toEqual([]);
  });

  it('修饰词表非空', () => {
    expect(MODIFIERS.length).toBeGreaterThan(10);
  });
});

describe('不查的地方', () => {
  it('代码块内不命中', () => {
    const text = ['正常文字', '```js', 'const 证据链 = 1;', '```'].join('\n');
    expect(words(text)).toEqual([]);
  });

  it('行内代码不命中', () => {
    expect(words('这里指的是 `API` 这个词本身。')).toEqual([]);
  });

  it('代码块外的同类词仍然命中（证明跳过是有边界的）', () => {
    const text = ['```js', 'const x = 1;', '```', '代码块外写了 API'].join('\n');
    expect(words(text)).toContain('API');
  });
});

describe('文件级豁免', () => {
  it('带豁免标记的文件整篇跳过，其余照查', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wording-'));
    try {
      const skip = join(dir, 'skip.md');
      const check = join(dir, 'check.md');
      writeFileSync(skip, `${FILE_ALLOW_MARKER}\n这里有 证据链 和 API。\n`, 'utf8');
      writeFileSync(check, '这里有 证据链。\n', 'utf8');
      const results = checkFiles([skip, check]);
      expect(results[0].skipped).toBe(true);
      expect(results[0].hits).toEqual([]);
      expect(results[1].skipped).toBe(false);
      expect(results[1].hits.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('合规文案', () => {
  it('照规范写的一段话零命中', () => {
    const text = [
      '装它以后，二十四个任务全对。不装的那一组，二十四个里对零个。',
      '装它用二十秒，装上一个用四分钟。',
      '它只记项目，不记偏好。',
    ].join('\n');
    expect(checkText(text)).toEqual([]);
  });
});
