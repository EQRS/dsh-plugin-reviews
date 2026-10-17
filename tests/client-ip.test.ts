/**
 * 真实客户端 IP 解析的行为边界。
 *
 * 这是**安全边界**：开关关着时，任何请求头都不得影响判定结果
 * （头是客户端可写的，认它等于让攻击者自己填日志与风控依据）。
 */

import { describe, expect, it } from 'vitest';
import { normalizeClientIp, resolveClientIp } from '../src/server/platform/client-ip.mjs';

describe('地址归一化', () => {
  it('去掉 IPv6 映射前缀、方括号与端口', () => {
    expect(normalizeClientIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('[::1]:443')).toBe('::1');
    expect(normalizeClientIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeClientIp('127.0.0.1:5555')).toBe('127.0.0.1');
    expect(normalizeClientIp('  203.0.113.7  ')).toBe('203.0.113.7');
  });

  it('纯 IPv6 与非法输入不被切坏', () => {
    // 2001:db8::1 没有点，不该被当成"IPv4 带端口"处理
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp('')).toBeNull();
    expect(normalizeClientIp(null)).toBeNull();
    expect(normalizeClientIp(123)).toBeNull();
  });
});

describe('客户端地址判定', () => {
  it('默认（未声明信任反代）：请求头一律不影响结果', () => {
    const result = resolveClientIp({
      headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.10.11.12' },
      socketAddress: '::ffff:172.18.0.1',
    });
    // 必须是对端地址（nginx 的地址），而不是伪造头里的值
    expect(result).toBe('172.18.0.1');
  });

  it('显式信任反代：优先用 X-Real-IP', () => {
    expect(
      resolveClientIp({
        headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' },
        socketAddress: '172.18.0.1',
        trustProxy: true,
      }),
    ).toBe('203.0.113.9');
  });

  it('显式信任反代：没有 X-Real-IP 时退回 X-Forwarded-For 的最左值', () => {
    expect(
      resolveClientIp({
        headers: { 'x-forwarded-for': '198.51.100.7, 172.18.0.1' },
        socketAddress: '172.18.0.1',
        trustProxy: true,
      }),
    ).toBe('198.51.100.7');
  });

  it('显式信任反代但头是空的：仍然回退到对端地址，不返回空值', () => {
    for (const headers of [{}, { 'x-real-ip': '' }, { 'x-real-ip': '  ' }, { 'x-forwarded-for': '' }]) {
      expect(resolveClientIp({ headers, socketAddress: '172.18.0.1', trustProxy: true })).toBe('172.18.0.1');
    }
  });

  it('重复头取第一个值（数组形态）', () => {
    expect(
      resolveClientIp({ headers: { 'x-real-ip': ['203.0.113.5', '203.0.113.6'] }, trustProxy: true }),
    ).toBe('203.0.113.5');
  });

  it('完全没有可用信息时返回 null，而不是拼一个假地址出来', () => {
    expect(resolveClientIp({ headers: {}, socketAddress: null, trustProxy: true })).toBeNull();
    expect(resolveClientIp()).toBeNull();
  });
});