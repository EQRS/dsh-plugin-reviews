/**
 * 业务状态文案集中映射（架构第 56、59、60 节：用户文案来自集中映射，
 * 不散落在各页面里，也不能靠匹配中文判断流程）。
 */

import type {
  AccountStatus,
  ModerationResult,
  RepositoryAvailabilityState,
  ReviewSourceKind,
  SubmissionState,
  TaskState,
  UserRole,
  VersionValue,
} from './field-rules';

export const submissionStateLabels: Record<SubmissionState, string> = {
  pending: '已提交，等待处理',
  checking: '正在检查',
  needs_changes: '需要修改或补充',
  manual_review: '等待人工处理',
  approved: '检查通过，等待发布',
  published: '已发布',
  ineligible: '已失去发布资格',
};

export const taskStateLabels: Record<TaskState, string> = {
  queued: '排队中',
  running: '执行中',
  retry_wait: '等待重试',
  succeeded: '执行完成',
  failed: '执行失败',
  skipped: '已跳过',
};

export const moderationResultLabels: Record<ModerationResult, string> = {
  pass: '检查通过',
  needs_changes: '需要修改',
  manual_review: '转人工处理',
  fault: '检查故障',
  ineligible: '不再具备处理资格',
};

export const reviewSourceLabels: Record<ReviewSourceKind, string> = {
  community: '社区评测',
  site: '站点评测',
};

export const repositoryAvailabilityLabels: Record<RepositoryAvailabilityState, string> = {
  unknown: '状态未知',
  available: '可访问',
  unavailable: '暂不可访问',
};

export const roleLabels: Record<UserRole, string> = {
  user: '普通用户',
  admin: '管理员',
};

export const accountStatusLabels: Record<AccountStatus, string> = {
  active: '正常',
  disabled: '已禁用',
};

/**
 * 版本标签文案（需求第 4 节）：显示类似 `插件 v1.2`、`DSH v0.3`。
 * 未知时保持“未知”，版本标签不是兼容承诺。
 */
export function formatVersionLabel(prefix: '插件' | 'DSH', version: VersionValue | null | undefined): string {
  if (!version) return `${prefix} 未知`;
  if (version.kind === 'unknown') return `${prefix} 未知`;
  return `${prefix} ${version.value}`;
}
