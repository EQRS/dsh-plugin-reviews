/**
 * 测试登录通道的闸门测试。
 *
 * 这是安全边界：它保证"接受任意身份"的入口在生产绝不可达。
 * 去掉 testLoginAllowed 的任何一条判断，对应用例必须变红。
 */

import { describe, expect, it } from 'vitest';
import { testLoginAllowed } from '../src/app/api/testing/session/route';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('测试登录通道闸门', () => {
  it('生产环境：即使显式开了开关也不允许', () => {
    expect(
      testLoginAllowed(env({ NODE_ENV: 'production', DSH_REVIEW_ALLOW_TEST_LOGIN: '1' })),
    ).toBe(false);
  });

  it('非生产但未开开关：不允许（默认关闭）', () => {
    expect(testLoginAllowed(env({ NODE_ENV: 'development' }))).toBe(false);
    expect(testLoginAllowed(env({}))).toBe(false);
  });

  it('开关值是 1 之外的内容：不允许（不接受 true/yes 之类的模糊写法）', () => {
    expect(testLoginAllowed(env({ NODE_ENV: 'development', DSH_REVIEW_ALLOW_TEST_LOGIN: 'true' }))).toBe(false);
    expect(testLoginAllowed(env({ NODE_ENV: 'development', DSH_REVIEW_ALLOW_TEST_LOGIN: 'yes' }))).toBe(false);
    expect(testLoginAllowed(env({ NODE_ENV: 'development', DSH_REVIEW_ALLOW_TEST_LOGIN: '0' }))).toBe(false);
  });

  it('非生产 + 开关为 1：允许（本地验收可用）', () => {
    expect(testLoginAllowed(env({ NODE_ENV: 'development', DSH_REVIEW_ALLOW_TEST_LOGIN: '1' }))).toBe(true);
  });
});
