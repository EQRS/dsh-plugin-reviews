/**
 * 规范摘要（架构第 66.3 节）。
 *
 * 请求摘要基于**已定义的规范化输入**生成；不能让校验前后含义发生变化却仍当成同一次操作。
 * 摘要用于请求去重（同键同摘要 → 原结果；同键不同摘要 → 冲突）。
 */

import { createHash } from 'node:crypto';

/** 稳定序列化：对象键排序，保证同一业务输入得到同一摘要。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en'));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** SHA-256 小写十六进制摘要。 */
export function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/** 对原始字符串取摘要（例如会话 token）。 */
export function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
