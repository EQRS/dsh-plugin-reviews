/**
 * 统一错误码（架构第 65 节）。
 *
 * 前端按错误码处理流程，不通过匹配中文提示判断。
 * 这里是本切片实际会抛出的**全部**错误码；没有实现的流程不预留空码。
 */

export const ErrorCodes = {
  /** 输入无效：字段类型、必填、格式不合法。 */
  INPUT_INVALID: 'input_invalid',
  /** 未登录或会话失效。 */
  UNAUTHENTICATED: 'unauthenticated',
  /** 权限不足：当前角色或归属不允许该操作。 */
  FORBIDDEN: 'forbidden',
  /** 账户被禁用：不阻止匿名浏览，但阻止登录与写入。 */
  ACCOUNT_DISABLED: 'account_disabled',
  /** 版本冲突或阶段已变化（草稿 save_version、提交 state_version、可见性控制版本）。 */
  VERSION_CONFLICT: 'version_conflict',
  /** 目标不可访问：不存在、未发布、已撤回、已隐藏。不泄露私有内容。 */
  TARGET_UNAVAILABLE: 'target_unavailable',
  /** 请求频率受限。 */
  RATE_LIMITED: 'rate_limited',
  /** 同键不同内容：请求去重键被复用但摘要不一致。 */
  REQUEST_KEY_REUSED: 'request_key_reused',
  /** 外部依赖未配置（GitHub OAuth / 审核服务）。不伪装可用。 */
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  /** 外部依赖故障：超时、限流、网络错误。 */
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  /** 服务器内部故障。堆栈只进服务端日志，不回传用户。 */
  INTERNAL: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 字段级错误，使用稳定字段路径（架构第 66 节）。 */
export interface FieldError {
  /** 例如 `title`、`plugin_version`、`items[2].plugin_version`。 */
  path: string;
  message: string;
}

export interface BusinessError {
  code: ErrorCode;
  /** 可展示说明；不得包含堆栈、SQL、凭据或第三方原始响应。 */
  message: string;
  fields?: FieldError[];
  /** 允许公开的上下文，例如受限等待秒数、当前阶段键。 */
  context?: Record<string, string | number | boolean | null>;
}

/** 业务错误异常：服务层抛出，接口层统一映射。 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly fields?: FieldError[];
  readonly context?: Record<string, string | number | boolean | null>;

  constructor(error: BusinessError) {
    super(error.message);
    this.name = 'DomainError';
    this.code = error.code;
    this.fields = error.fields;
    this.context = error.context;
  }

  toBusinessError(): BusinessError {
    const out: BusinessError = { code: this.code, message: this.message };
    if (this.fields) out.fields = this.fields;
    if (this.context) out.context = this.context;
    return out;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

// ---- 构造助手：让各模块不必重复写对象字面量 ----

export const err = {
  input: (message: string, fields?: FieldError[]) =>
    new DomainError(fields ? { code: ErrorCodes.INPUT_INVALID, message, fields } : { code: ErrorCodes.INPUT_INVALID, message }),
  unauthenticated: (message = '需要登录后才能继续。') =>
    new DomainError({ code: ErrorCodes.UNAUTHENTICATED, message }),
  forbidden: (message = '当前操作无权执行。') => new DomainError({ code: ErrorCodes.FORBIDDEN, message }),
  disabled: (message = '账户已被禁用，无法执行该操作。') =>
    new DomainError({ code: ErrorCodes.ACCOUNT_DISABLED, message }),
  conflict: (message: string, context?: Record<string, string | number | boolean | null>) =>
    new DomainError(context ? { code: ErrorCodes.VERSION_CONFLICT, message, context } : { code: ErrorCodes.VERSION_CONFLICT, message }),
  unavailable: (message = '目标当前不可访问。') =>
    new DomainError({ code: ErrorCodes.TARGET_UNAVAILABLE, message }),
  rateLimited: (message: string, context?: Record<string, string | number | boolean | null>) =>
    new DomainError(context ? { code: ErrorCodes.RATE_LIMITED, message, context } : { code: ErrorCodes.RATE_LIMITED, message }),
  keyReused: (message = '同一请求标识不能对应不同内容。') =>
    new DomainError({ code: ErrorCodes.REQUEST_KEY_REUSED, message }),
  notConfigured: (message: string) => new DomainError({ code: ErrorCodes.PROVIDER_NOT_CONFIGURED, message }),
  providerDown: (message: string) => new DomainError({ code: ErrorCodes.PROVIDER_UNAVAILABLE, message }),
  internal: (message = '服务器处理失败，请稍后重试。') => new DomainError({ code: ErrorCodes.INTERNAL, message }),
};
