/**
 * Cookie 策略：环境 → 名字与 Secure 标志。
 *
 * 为什么值得单独钉住：这个映射错了不会报错，只会在浏览器里表现为
 * "登录接口 200，下一次请求就变匿名"（`__Host-` / `Secure` 的 Cookie 在 http 下被丢弃），
 * 极难排查 —— 本项目已经被同一个坑咬过一次。
 *
 * 反同义反复：把 `resolveCookieMode` 里 `secure` 的 `&& !insecureOverride` 去掉，第 3 条用例必然变红。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveCookieMode,
  SESSION_COOKIE_DEV,
  SESSION_COOKIE_PROD,
} from '../src/server/platform/session-cookie';

describe('Cookie 策略（resolveCookieMode）', () => {
  it('开发环境：不带 __Host- 前缀、不加 Secure（http 下才收得到）', () => {
    const mode = resolveCookieMode({ NODE_ENV: 'development' });
    expect(mode.name).toBe(SESSION_COOKIE_DEV);
    expect(mode.secure).toBe(false);
    expect(mode.insecureOverride).toBe(false);
  });

  it('生产环境：用 __Host- 前缀 + Secure（HTTPS 下才生效）', () => {
    const mode = resolveCookieMode({ NODE_ENV: 'production' });
    expect(mode.name).toBe(SESSION_COOKIE_PROD);
    expect(mode.secure).toBe(true);
    expect(mode.insecureOverride).toBe(false);
  });

  it('生产但显式声明"没有 TLS"：回退到开发那套，并标记为降级状态', () => {
    const mode = resolveCookieMode({ NODE_ENV: 'production', DSH_REVIEW_INSECURE_COOKIES: '1' });
    expect(mode.secure).toBe(false);
    expect(mode.name).toBe(SESSION_COOKIE_DEV);
    // 关键：它必须被标记出来，否则"降级"会变成没人记得的常态
    expect(mode.insecureOverride).toBe(true);
  });

  it('这个开关只在生产下有意义；开发环境写它不算"降级"', () => {
    const mode = resolveCookieMode({ NODE_ENV: 'development', DSH_REVIEW_INSECURE_COOKIES: '1' });
    expect(mode.secure).toBe(false);
    expect(mode.name).toBe(SESSION_COOKIE_DEV);
    expect(mode.insecureOverride).toBe(false);
  });

  it('只认恰好为 1（避免 "true"/"yes" 这类写法被误当作开启）', () => {
    for (const v of ['true', 'yes', '0', '', '  1  ']) {
      const mode = resolveCookieMode({ NODE_ENV: 'production', DSH_REVIEW_INSECURE_COOKIES: v });
      if (v.trim() === '1') {
        expect(mode.insecureOverride).toBe(true);
      } else {
        expect(mode.insecureOverride).toBe(false);
        expect(mode.name).toBe(SESSION_COOKIE_PROD);
      }
    }
  });
});
