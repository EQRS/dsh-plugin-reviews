/**
 * 首页辅栏「近期更新插件」的间距不变量。
 *
 * 主人报过：窗口一矮，上下两个插件的信息就叠在一起。根因是桌面端用
 * `flex: 1 1 0` 把 10 条均分到面板高度、又给了 `min-height: 0` 允许压到 0，
 * 卡片里三行字不收缩也不裁切，条目被压穿后文字就串行。
 *
 * 这里不测视觉，只把导致重叠的那几条规则钉住：条目必须有非零最小高度，
 * 且 flex 的收缩基线不能再回到 0。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** 取一个选择器的规则体（只取第一处出现，够用）。 */
function ruleBody(selector: string): string {
  const at = css.indexOf(selector + ' {');
  if (at === -1) throw new Error('找不到规则：' + selector);
  const start = css.indexOf('{', at);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

/** 取一个选择器的**最后一处**规则体（媒体查询会覆盖同名选择器）。 */
function lastRuleBody(selector: string): string {
  const at = css.lastIndexOf(selector + ' {');
  if (at === -1) throw new Error('找不到规则：' + selector);
  const start = css.indexOf('{', at);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

function minHeightPx(body: string): number {
  const m = body.match(/min-height:\s*(\d+)px/);
  if (!m) throw new Error('规则里没有 px 单位的 min-height');
  return Number(m[1]);
}

describe('首页近期更新插件：条目不重叠', () => {
  it('条目最小高度不为 0，且能容纳「标题 + 简介 + 元信息」三行**加内边距**', () => {
    const body = ruleBody('.item-list > .home-plugin-item');
    const minHeight = minHeightPx(body);
    // 三行文字的实际行高：标题 14×1.35 + 简介 12×1.4 + 元信息 11×1.4 ≈ 51px。
    // globals.css 顶部有 `box-sizing: border-box`，min-height 包含内边距，
    // 所以下限必须是 51 + 上下 padding（8×2 = 16）→ 67 起步；只写 51/52
    // 会把内容盒挤到 36px，窗口一矮文字仍然溢出（上一版就是这么漏的）。
    const paddingY = Number(body.match(/padding:\s*(\d+)px/)?.[1] ?? NaN);
    expect(Number.isFinite(paddingY)).toBe(true);
    expect(minHeight).toBeGreaterThanOrEqual(51 + paddingY * 2);
  });

  it('手机端下限同样扣掉上下内边距后仍装得下两行（约 34px）', () => {
    const mobile = lastRuleBody('.item-list > .home-plugin-item');
    const minHeight = minHeightPx(mobile);
    const paddingY = Number(mobile.match(/padding:\s*(\d+)px/)?.[1] ?? NaN);
    expect(minHeight).toBeGreaterThanOrEqual(34 + paddingY * 2);
  });

  it('条目上下内边距给足，相邻两条之间有可见间隔', () => {
    const body = ruleBody('.item-list > .home-plugin-item');
    const m = body.match(/padding:\s*(\d+)px/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(8);
  });

  it('桌面端均分用 auto 基线，不再用会一路压穿的 0 基线', () => {
    const body = ruleBody('.home-feed aside .home-plugin-list > .home-plugin-item');
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).not.toMatch(/flex:\s*1 1 0/);
  });
});
