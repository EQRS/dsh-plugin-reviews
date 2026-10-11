/**
 * 全站字段规范（数据库模型第 1 节、架构第 55 节）。
 *
 *  - ID：规范小写 UUIDv7 的 TEXT；
 *  - 时刻：Unix 纪元起算的 UTC 毫秒整数；
 *  - 布尔：INTEGER 且 CHECK IN (0,1)；
 *  - 字符串：不得用空字符串冒充空关联，必填名称/原因/请求键拒绝纯空白。
 */

export type Id = string;
export type Timestamp = number;
export type Bool01 = 0 | 1;

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: unknown): value is Id {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

/** 规范摘要：小写十六进制 SHA-256。 */
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/** 必填文本：非空且非纯空白。 */
export function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---- 状态与结构注册（数据库模型第 2 节，仅本切片用到的子集） ----

export const UserRoles = ['user', 'admin'] as const;
export type UserRole = (typeof UserRoles)[number];

export const AccountStatuses = ['active', 'disabled'] as const;
export type AccountStatus = (typeof AccountStatuses)[number];

export const IdentityProviders = ['github'] as const;
export type IdentityProvider = (typeof IdentityProviders)[number];

export const RepositoryAvailabilityStates = ['unknown', 'available', 'unavailable'] as const;
export type RepositoryAvailabilityState = (typeof RepositoryAvailabilityStates)[number];

/** 公共内容类型：本切片只实现 review；pack_release 保留枚举以维持 CHECK 形状。 */
export const ContentTypes = ['review', 'pack_release'] as const;
export type ContentType = (typeof ContentTypes)[number];

export const ReviewSourceKinds = ['community', 'site'] as const;
export type ReviewSourceKind = (typeof ReviewSourceKinds)[number];

/** 草稿类型：本切片只实现 review。 */
export const DraftTypes = ['review', 'pack'] as const;
export type DraftType = (typeof DraftTypes)[number];

export const SubmissionTypes = ['review_revision', 'comment_revision'] as const;
export type SubmissionType = (typeof SubmissionTypes)[number];

/** 提交处理状态（架构第 56 节完整定义，本切片实现其中可到达的全部阶段）。 */
export const SubmissionStates = [
  'pending',
  'checking',
  'needs_changes',
  'manual_review',
  'approved',
  'published',
  'ineligible',
] as const;
export type SubmissionState = (typeof SubmissionStates)[number];

/** 处理记录结果（架构第 20 节注册集合的切片子集）。 */
export const ModerationResults = ['pass', 'needs_changes', 'manual_review', 'fault', 'ineligible'] as const;
export type ModerationResult = (typeof ModerationResults)[number];

export const ModerationActorKinds = ['user', 'admin', 'system'] as const;
export type ModerationActorKind = (typeof ModerationActorKinds)[number];

/** 任务状态（架构第 59 节完整定义；本切片实现全部六个）。 */
export const TaskStates = ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'skipped'] as const;
export type TaskState = (typeof TaskStates)[number];

/** 任务尝试结果（架构第 59 节）。进行中为 NULL，结束后不可改写。 */
export const AttemptOutcomes = ['success', 'error', 'lease_expired', 'skipped'] as const;
export type AttemptOutcome = (typeof AttemptOutcomes)[number];

/** 本切片注册的任务类型。注册集合随迁移版本维护，不能由配置注入新类型。 */
export const TaskTypes = ['review_check', 'review_publish', 'comment_check', 'comment_publish'] as const;
export type TaskType = (typeof TaskTypes)[number];

export const OperationActorKinds = ['user', 'admin', 'system'] as const;
export type OperationActorKind = (typeof OperationActorKinds)[number];

/**
 * 版本结构（架构第 26 节）：区分已知值与明确未知。
 * 不用字符串 `latest` 代替未知，也不把未知当成缺失字段。
 */
export interface VersionKnown {
  kind: 'known';
  /** 作者实际填写或被选中的版本标识；可能是 semver，也可能是提交号，不做统一语义化改写。 */
  value: string;
  /** 可选来源线索（例如 npm 包名、GitHub 提交）。 */
  source?: string;
}
export interface VersionUnknown {
  kind: 'unknown';
  /** 可选说明，例如“作者未提供版本”。 */
  reason?: string;
}
export type VersionValue = VersionKnown | VersionUnknown;

export const VersionKinds = ['known', 'unknown'] as const;
