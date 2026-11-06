/**
 * 身份申请面板的四态判定（纯函数，不碰数据库）。
 *
 * 为什么单独测这一段：面板上有五种形态（已持有 / 审核中 / 冷却中 / 资格够 / 资格缺），
 * 写成一串 if 最容易出现「按钮能点但点了必失败」这类问题。判定抽成纯函数之后，
 * 每种形态都能单独钉死；页面只是把结论画出来。
 */

import { describe, expect, it } from 'vitest';
import {
  buildRolePanel,
  decideRoleAction,
  heldRolesText,
  remainingCooldownDays,
  type RolePanelInput,
} from '../src/packages/common/roles';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function baseInput(over: Partial<RolePanelInput> = {}): RolePanelInput {
  return {
    roles: [],
    pending: [],
    rejected: [],
    eligibility: {
      reviewer: { count: 0, required: 1 },
      developer: { count: 0, required: 1 },
    },
    cooldownDays: 30,
    now: NOW,
    ...over,
  };
}

describe('decideRoleAction 的五种形态', () => {
  it('已持有 → 无按钮，说明「已是该身份」', () => {
    const input = baseInput({ roles: [{ roleType: 'reviewer', grantedAt: NOW - DAY }] });
    const d = decideRoleAction(input, 'reviewer');
    expect(d.state).toBe('held');
    expect(d.buttonLabel).toBe('');
    expect(d.statusText).toContain('已是');
  });

  it('审核中 → 无按钮但可以撤回', () => {
    const input = baseInput({
      pending: [{ id: 'app1', roleType: 'reviewer', createdAt: NOW, note: null }],
    });
    const d = decideRoleAction(input, 'reviewer');
    expect(d.state).toBe('pending');
    expect(d.canWithdraw).toBe(true);
    expect(d.pendingApplicationId).toBe('app1');
    expect(d.buttonLabel).toBe('');
  });

  it('冷却中 → 按钮置灰，带驳回理由与剩余天数', () => {
    const input = baseInput({
      rejected: [{ id: 'r1', roleType: 'developer', reviewedAt: NOW - DAY, reviewNote: '证据不足' }],
    });
    const d = decideRoleAction(input, 'developer');
    expect(d.state).toBe('cooldown');
    expect(d.disabled).toBe(true);
    expect(d.rejectionNote).toBe('证据不足');
    expect(d.remainingDays).toBe(29);
  });

  it('冷却期满 → 回到可申请状态', () => {
    const input = baseInput({
      eligibility: {
        reviewer: { count: 1, required: 1 },
        developer: { count: 0, required: 1 },
      },
      rejected: [{ id: 'r1', roleType: 'reviewer', reviewedAt: NOW - 31 * DAY, reviewNote: 'x' }],
    });
    const d = decideRoleAction(input, 'reviewer');
    expect(d.state).toBe('eligible');
    expect(d.disabled).toBe(false);
    expect(d.buttonLabel).toBe('申请');
  });

  it('资格缺 → 按钮置灰，并把人引到该补的地方', () => {
    const dev = decideRoleAction(baseInput(), 'developer');
    expect(dev.state).toBe('ineligible');
    expect(dev.disabled).toBe(true);
    expect(dev.buttonLabel).toBe('去认领插件');

    const rev = decideRoleAction(baseInput(), 'reviewer');
    expect(rev.buttonLabel).toBe('去写测评');
  });

  it('资格够 → 可点', () => {
    const input = baseInput({
      eligibility: {
        reviewer: { count: 3, required: 1 },
        developer: { count: 0, required: 1 },
      },
    });
    const d = decideRoleAction(input, 'reviewer');
    expect(d.state).toBe('eligible');
    expect(d.disabled).toBe(false);
  });

  it('冷却中但资格也够 → 仍是 cooldown（缺的是冷却不是资格）', () => {
    const input = baseInput({
      eligibility: {
        reviewer: { count: 5, required: 1 },
        developer: { count: 0, required: 1 },
      },
      rejected: [{ id: 'r1', roleType: 'reviewer', reviewedAt: NOW - DAY, reviewNote: '再等等' }],
    });
    const d = decideRoleAction(input, 'reviewer');
    expect(d.state).toBe('cooldown');
    expect(d.qualified).toBe(true);
  });
});

describe('辅助函数', () => {
  it('remainingCooldownDays 按天向上取整', () => {
    expect(remainingCooldownDays(NOW - DAY, 30, NOW)).toBe(29);
    expect(remainingCooldownDays(NOW, 30, NOW)).toBe(30);
    expect(remainingCooldownDays(NOW - 31 * DAY, 30, NOW)).toBe(0);
  });

  it('heldRolesText 没有身份时给出可操作提示', () => {
    expect(heldRolesText([])).toContain('申请');
    expect(heldRolesText(['测评员'])).toBe('测评员');
    expect(heldRolesText(['测评员', '开发者'])).toBe('测评员、开发者');
  });

  it('buildRolePanel 汇总两个身份，并统计冷却中的条数', () => {
    const input = baseInput({
      roles: [{ roleType: 'reviewer', grantedAt: NOW }],
      rejected: [{ id: 'r1', roleType: 'developer', reviewedAt: NOW, reviewNote: 'x' }],
    });
    const panel = buildRolePanel(input);
    expect(panel.actions).toHaveLength(2);
    expect(panel.heldLabels).toEqual(['测评员']);
    expect(panel.coolingDownCount).toBe(1);
  });
});
