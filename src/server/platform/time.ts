/**
 * 统一时间服务（架构第 55 节）。
 *
 * 规则：
 *  - 数据库中所有时刻为 Unix 纪元起算的 UTC 毫秒整数；
 *  - 业务代码不得散落 Date.now()；
 *  - 调用方可注入 `now` 以便测试确定性。
 */

/** 当前 UTC 毫秒。 */
export function nowMs(): number {
  return Date.now();
}

/** 毫秒 → 带 UTC 标识的接口时间字符串（架构第 55 节：不直接返回含义不明的数字）。 */
export function toIsoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function seconds(n: number): number {
  return n * SECOND;
}

/** 判断某个带期限的时刻是否仍然有效（严格大于当前时间）。 */
export function notExpired(expiresAt: number | null | undefined, now: number): boolean {
  return typeof expiresAt === 'number' && expiresAt > now;
}
