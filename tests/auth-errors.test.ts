/**
 * 鉴权错误的 HTTP 映射回归测试。
 *
 * 背景：这是 gf-platform 在验收时**真实发现**的缺陷 ——
 * `assertCanWrite` 原本抛裸 `Error('UNAUTHENTICATED')`，
 * 经统一映射会被折成 500/internal，把「未登录」和「账户禁用」误报成服务器故障。
 *
 * 本文件的用例在缺陷复现时必须变红；修好后必须通过。
 */

import { describe, expect, it } from 'vitest';
import { assertCanAdmin, assertCanWrite, anonymousContext, type CallerContext } from '../src/server/platform/context';
import { statusForErrorCode, toBusinessError } from '../src/server/platform/errors-http';
import { ErrorCodes, DomainError, err } from '../src/packages/common/errors';

const activeUser: CallerContext = { userId: 'u1', role: 'user', accountStatus: 'active' };
const activeAdmin: CallerContext = { userId: 'a1', role: 'admin', accountStatus: 'active' };
const disabledUser: CallerContext = { userId: 'u2', role: 'user', accountStatus: 'disabled' };

describe('鉴权前置校验必须抛 DomainError（而非裸 Error）', () => {
  it('匿名写入 → unauthenticated / 401，而不是 500', () => {
    let thrown: unknown;
    try {
      assertCanWrite(anonymousContext);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const mapped = toBusinessError(thrown);
    expect(mapped.code).toBe(ErrorCodes.UNAUTHENTICATED);
    expect(statusForErrorCode(mapped.code)).toBe(401);
  });

  it('禁用账户写入 → account_disabled / 403，而不是 500', () => {
    let thrown: unknown;
    try {
      assertCanWrite(disabledUser);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const mapped = toBusinessError(thrown);
    expect(mapped.code).toBe(ErrorCodes.ACCOUNT_DISABLED);
    expect(statusForErrorCode(mapped.code)).toBe(403);
  });

  it('普通用户执行管理员操作 → forbidden / 403', () => {
    let thrown: unknown;
    try {
      assertCanAdmin(activeUser);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const mapped = toBusinessError(thrown);
    expect(mapped.code).toBe(ErrorCodes.FORBIDDEN);
    expect(statusForErrorCode(mapped.code)).toBe(403);
  });

  it('合规调用不抛错（证明上面的断言不是靠"永远抛错"通过的）', () => {
    expect(() => assertCanWrite(activeUser)).not.toThrow();
    expect(() => assertCanAdmin(activeAdmin)).not.toThrow();
  });
});

describe('未知异常兜底不泄露内部信息', () => {
  it('裸 Error 被折成 internal，原始 message 不出现在响应里', () => {
    const leaky = new Error('SELECT * FROM users; token=hunter2');
    const mapped = toBusinessError(leaky);
    expect(mapped.code).toBe(ErrorCodes.INTERNAL);
    expect(statusForErrorCode(mapped.code)).toBe(500);
    expect(JSON.stringify(mapped)).not.toContain('hunter2');
    expect(JSON.stringify(mapped)).not.toContain('SELECT');
    expect(JSON.stringify(mapped)).not.toContain('at ');
  });

  it('非 Error 抛出物同样兜底为 internal', () => {
    for (const weird of [null, undefined, 'boom', 42, { nope: true }]) {
      expect(toBusinessError(weird).code).toBe(ErrorCodes.INTERNAL);
    }
  });
});

describe('错误码到状态码的映射覆盖全部注册码', () => {
  it('每个 ErrorCodes 成员都有明确的非 500 状态（internal 自身除外）', () => {
    for (const code of Object.values(ErrorCodes)) {
      const status = statusForErrorCode(code);
      expect(status).toBeGreaterThanOrEqual(400);
      if (code !== ErrorCodes.INTERNAL) {
        // 若某个码没被登记，会落到默认 500 —— 那说明映射表漏了它。
        expect(status, `错误码 ${code} 未被登记状态码`).not.toBe(500);
      }
    }
  });

  it('err.* 构造器产出的都是 DomainError', () => {
    const samples = [
      err.input('x'),
      err.unauthenticated(),
      err.forbidden(),
      err.disabled(),
      err.conflict('x'),
      err.unavailable(),
      err.rateLimited('x'),
      err.keyReused(),
      err.notConfigured('x'),
      err.providerDown('x'),
      err.internal(),
    ];
    for (const s of samples) {
      expect(s).toBeInstanceOf(DomainError);
    }
  });
});
