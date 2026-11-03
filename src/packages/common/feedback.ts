/**
 * 问题反馈的纯常量与类型：客户端与服务端共用。
 *
 * 放在 packages/common 是因为**客户端组件也要用**（类型选择、状态文案）；
 * 如果留在 server/modules/feedback，客户端会把整个 db 层打进 bundle。
 */

export const FEEDBACK_KINDS = ['bug', 'feature', 'content', 'account', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = [
  'open',
  'acknowledged',
  'fixed',
  'duplicate',
  'wontfix',
  'unreproducible',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  bug: '功能异常',
  feature: '功能建议',
  content: '内容问题',
  account: '账号问题',
  other: '其他',
};

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: '待处理',
  acknowledged: '已确认',
  fixed: '已修复',
  duplicate: '重复',
  wontfix: '不修',
  unreproducible: '无法复现',
};

export const FEEDBACK_ACTIONS = [
  'acknowledge',
  'fix',
  'duplicate',
  'wontfix',
  'unreproducible',
  'reopen',
] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

export const FEEDBACK_ACTION_LABELS: Record<FeedbackAction, string> = {
  acknowledge: '确认问题',
  fix: '标记已修复',
  duplicate: '标为重复',
  wontfix: '决定不修',
  unreproducible: '无法复现',
  reopen: '重新打开',
};

export const FEEDBACK_LIMITS = {
  titleMax: 120,
  bodyMax: 5000,
  reasonMax: 1000,
  replyMax: 2000,
  pageUrlMax: 1000,
  contextMax: 2000,
  /** 同一人 + 同一类型 + 同一页面，这个窗口内只留一张票。 */
  dedupeWindowMs: 24 * 60 * 60 * 1000,
} as const;
