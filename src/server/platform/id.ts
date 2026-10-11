/**
 * 统一 ID 服务（架构第 55 节）。
 *
 * 站内对象 ID 为规范小写 UUIDv7（RFC 9562），SQLite 用 TEXT 保存。
 * UUIDv7 的时间字段有利于按生成时间组织标识；但**列表业务顺序仍使用实际业务时间 + 固定 ID**，
 * 不把 UUID 排序当成严格业务发生顺序。
 */

import { randomBytes } from 'node:crypto';

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    out += HEX[(b >> 4) & 0xf];
    out += HEX[b & 0xf];
  }
  return out;
}

/**
 * 生成 UUIDv7。
 * 布局：48 位毫秒时间戳 | 4 位版本(7) | 12 位随机 | 2 位变体(10) | 62 位随机
 */
export function newId(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 前 48 位：毫秒时间戳（大端）
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // 版本 7
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  // 变体 10xx
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 生成不可预测的会话凭证（仅明文出现在 Cookie，库里只存摘要）。 */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
