/**
 * OAuth 回跳路径规范化：开放重定向的回归用例。
 *
 * 依据（2026-10-18 外部审计 PR-01）：黑名单式校验（只拒 // 与 CR/LF）可被
 * 反斜杠/制表符绕过 —— 浏览器在 http(s) 这类 special scheme 下把 \ 当 /，
 * `/\evil.example` 会被解析成协议相对地址 `//evil.example`。
 */

import { describe, expect, it } from 'vitest';
import { normalizeReturnPath } from '../src/server/modules/identity/oauth-challenges';

describe('normalizeReturnPath：只放行站内相对路径', () => {
  it('合法站内路径原样通过（含查询串）', () => {
    expect(normalizeReturnPath('/plugins')).toBe('/plugins');
    expect(normalizeReturnPath('/reviews?tab=1')).toBe('/reviews?tab=1');
    expect(normalizeReturnPath('  /plugins  ')).toBe('/plugins');
  });

  it('协议相对地址被拒（//evil.example）', () => {
    expect(normalizeReturnPath('//evil.example')).toBe('/');
    expect(normalizeReturnPath('//evil.example/path')).toBe('/');
  });

  it('反斜杠变体被拒（/\evil.example 在浏览器里等价于 //evil.example）', () => {
    expect(normalizeReturnPath('/\\evil.example')).toBe('/');
    expect(normalizeReturnPath('/\\evil.example/path')).toBe('/');
    expect(normalizeReturnPath('\\\\evil.example')).toBe('/');
  });

  it('嵌入的控制字符被拒；首尾空白按 trim 语义去掉（不构成二次构造）', () => {
    expect(normalizeReturnPath('/plugins\tx')).toBe('/');
    expect(normalizeReturnPath('/plugins\u0000')).toBe('/');
    // 首尾的 CR/LF 被 trim 掉后是无害的相对路径，不该误杀
    expect(normalizeReturnPath('/plugins\r\n')).toBe('/plugins');
  });

  it('绝对地址与非法输入回到首页', () => {
    expect(normalizeReturnPath('http://evil.example/')).toBe('/');
    expect(normalizeReturnPath('https://evil.example')).toBe('/');
    expect(normalizeReturnPath('')).toBe('/');
    expect(normalizeReturnPath(null)).toBe('/');
    expect(normalizeReturnPath(undefined)).toBe('/');
    expect(normalizeReturnPath(123 as unknown as string)).toBe('/');
  });
});
