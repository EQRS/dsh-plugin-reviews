/**
 * 时间展示（服务端渲染用）。
 *
 * 为什么必须显式指定时区：`new Date(ms).toLocaleString('zh-CN')` 用的是**服务器本地时区**。
 * 线上 VPS 是 UTC，于是页面上所有时间都比北京时间**少 8 小时** —— 而且本机开发时看不出来
 * （本机是 +08:00），属于"本地全对、线上全错"的典型。这里把时区钉死成 Asia/Shanghai，
 * 与运行环境无关。
 *
 * 时间戳本身一律是 **UTC 毫秒**（数据库纪律），只有展示时才转时区。
 */

const SHANGHAI = 'Asia/Shanghai';

// Intl 实例建一次复用（每次调用都新建会明显变慢）。
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `2026/10/13 21:45`（北京时间）。 */
export function formatDateTime(ms: number): string {
  return dateTimeFormatter.format(new Date(ms));
}

/** 只到日期：`2026/10/13`（北京时间）。 */
export function formatDate(ms: number): string {
  return dateTimeFormatter.format(new Date(ms)).replace(/\s+\d{1,2}:\d{2}$/, '');
}

/** 可能为空的时间戳：空时给兜底文案（**不显示 1970 或 NaN**）。 */
export function formatDateTimeOr(ms: number | null | undefined, fallback: string): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? formatDateTime(ms) : fallback;
}
