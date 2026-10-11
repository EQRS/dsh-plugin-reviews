/**
 * 业务错误 → HTTP 响应映射（架构第 65 节，供接口层统一使用）。
 *
 * 约定：成功返回 `{ ok: true, data, request_id }`；失败返回 `{ ok: false, error, request_id }`。
 * 前端按稳定 `code` 处理流程，**不通过匹配中文提示判断**，所以这里 `message` 可以改文案，
 * `code` 与状态码不可随手改。
 *
 * 三条硬规则：
 *  1. 未知异常一律折成 `internal` 且返回 500；**堆栈只进服务端日志，绝不回传**。
 *  2. `provider_unavailable` / `provider_not_configured` 不伪装成 200 或"空结果"，让界面能如实提示临时故障。
 *  3. `target_unavailable` 对无权获知的私有对象同样返回，**不通过错误细节泄露**作者、修订或内部核查状态。
 *
 * ⚠️ 这里的 `request_id` 只用于日志关联；用户操作去重请用 `request_key`，业务审计去重请用 `operation_key`
 * （见 `./request-id.ts` 与架构第 65 节）。本模块不参与任何去重判定。
 */

import {
  ErrorCodes,
  isDomainError,
  type BusinessError,
  type ErrorCode,
} from '@/packages/common/errors';
import { fail, ok, type FailResult, type OkResult } from '@/packages/common/result';
import { log } from './log';
import { newRequestId, withRequestIdHeader, REQUEST_ID_HEADER } from './request-id';

/** 错误码 → HTTP 状态码。覆盖 `ErrorCodes` 的全部成员，新增错误码时类型检查会在此处报错。 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ErrorCodes.INPUT_INVALID]: 400,
  [ErrorCodes.UNAUTHENTICATED]: 401,
  // 403 而非 401：已登录但权限不足，不应清掉会话或引导重新登录。
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.ACCOUNT_DISABLED]: 403,
  [ErrorCodes.VERSION_CONFLICT]: 409,
  [ErrorCodes.TARGET_UNAVAILABLE]: 404,
  [ErrorCodes.RATE_LIMITED]: 429,
  // 同键不同摘要属于"请求冲突"，不是服务器故障。
  [ErrorCodes.REQUEST_KEY_REUSED]: 409,
  // 外部依赖未配置／故障：是服务端暂时不可用，不是客户端错误。
  [ErrorCodes.PROVIDER_NOT_CONFIGURED]: 503,
  [ErrorCodes.PROVIDER_UNAVAILABLE]: 503,
  [ErrorCodes.INTERNAL]: 500,
};

export function statusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * 只回传允许公开的字段。
 *
 * 白名单式构造而非删除式构造：即使将来 `DomainError` 增加了承载内部信息的属性，
 * 也不会因为忘记过滤而顺着响应泄漏出去。
 */
function toPublicError(code: ErrorCode, message: string, fields?: BusinessError['fields'], context?: BusinessError['context']): BusinessError {
  const out: BusinessError = { code, message };
  if (fields && fields.length > 0) out.fields = fields.map((f) => ({ path: f.path, message: f.message }));
  if (context && Object.keys(context).length > 0) out.context = { ...context };
  return out;
}

/** 把任意抛出物折成可公开的业务错误。未登记的错误码一律按 `internal` 处理，不猜测其含义。 */
export function toBusinessError(e: unknown): BusinessError {
  if (isDomainError(e)) {
    if (Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, e.code)) {
      return toPublicError(e.code, e.message, e.fields, e.context);
    }
    // 运行期防御：理论上 ErrorCode 联合类型已穷尽，但对象可能来自未类型化的边界。
    return toPublicError(ErrorCodes.INTERNAL, '服务器处理失败，请稍后重试。');
  }
  return toPublicError(ErrorCodes.INTERNAL, '服务器处理失败，请稍后重试。');
}

/** 构造失败响应：`{ ok: false, error, request_id }`。 */
export function failResult(e: unknown, requestId: string): FailResult {
  return fail(toBusinessError(e), requestId);
}

/** 构造成功响应：`{ ok: true, data, request_id }`。 */
export function okResult<T>(data: T, requestId: string): OkResult<T> {
  return ok(data, requestId);
}

/**
 * 把未知异常折算成 `Response` 所需的全部材料，不产生副作用。
 *
 * 副作用（写日志）单独放在 `logUnknownError` 里，便于测试只验证映射结果，
 * 也便于调用方在需要时自己决定是否记录。
 */
export interface ErrorResponseParts {
  status: number;
  body: FailResult;
  headers: Record<string, string>;
}

export function toErrorResponseParts(e: unknown, requestId: string): ErrorResponseParts {
  const error = toBusinessError(e);
  return {
    status: statusForErrorCode(error.code),
    body: fail(error, requestId),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [REQUEST_ID_HEADER]: requestId,
    },
  };
}

/**
 * 服务端日志：只有这里能看到真实异常与堆栈。
 *
 * 不记录请求体与凭据（`log` 已对敏感键名做遮蔽）；`stack` 走日志而非响应体，
 * 因此用户拿到的只有可展示说明与 `request_id`。
 */
export function logUnknownError(e: unknown, requestId: string, context?: Record<string, string | number | boolean | null>): void {
  if (isDomainError(e)) {
    // 业务错误是预期路径：仅记错误码，不记堆栈，避免正常流程刷爆错误日志。
    log.warn('domain_error', { request_id: requestId, code: e.code, ...(context ?? {}) });
    return;
  }
  log.error('unhandled_error', {
    request_id: requestId,
    code: ErrorCodes.INTERNAL,
    error_name: e instanceof Error ? e.name : typeof e,
    error_message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? (e.stack ?? null) : null,
    ...(context ?? {}),
  });
}

/** 是否属于"应当写 error 级日志"的未知异常（业务错误只写 warn）。 */
export function isUnexpected(e: unknown): boolean {
  return !isDomainError(e);
}

/**
 * 由未知异常直接产出 `Response`。
 *
 * 统一在这里落日志：调用方不必记得"先记日志再返回"，避免漏记找不到追踪号对应的原因。
 * 成功路径请用 `jsonOk`/`okResponse`。
 */
export function errorResponse(e: unknown, requestId: string, context?: Record<string, string | number | boolean | null>): Response {
  logUnknownError(e, requestId, context);
  const parts = toErrorResponseParts(e, requestId);
  return new Response(JSON.stringify(parts.body), { status: parts.status, headers: parts.headers });
}

/** 成功响应：同样把 `request_id` 放进响应头，便于前端网络面板直接对照。 */
export function jsonOk<T>(data: T, requestId: string, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  withRequestIdHeader(headers, requestId);
  return new Response(JSON.stringify(ok(data, requestId)), { status, headers });
}

/** 失败响应（已持有业务错误时使用；未捕获异常的入口请用 `errorResponse`）。 */
export function jsonFail(error: BusinessError, requestId: string): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  withRequestIdHeader(headers, requestId);
  return new Response(JSON.stringify(fail(error, requestId)), {
    status: statusForErrorCode(error.code),
    headers,
  });
}

/**
 * 包裹一个接口处理器：成功取 `data`，抛错走统一映射。
 *
 * 只做映射，不重试、不吞异常——重试语义按各业务操作自己的去重规则处理。
 */
export async function handleApi<T>(
  requestId: string,
  run: () => Promise<T> | T,
  context?: Record<string, string | number | boolean | null>,
): Promise<Response> {
  try {
    const data = await run();
    return jsonOk(data, requestId);
  } catch (e) {
    return errorResponse(e, requestId, context);
  }
}

/**
 * 未显式传入 `request_id` 时的兜底入口：生成一个新的再执行。
 * 正常链路应由接口层从请求头读取后传入（见 `requestIdFromHeaders`）。
 */
export async function handleApiWithNewRequestId<T>(run: (requestId: string) => Promise<T> | T): Promise<Response> {
  const requestId = newRequestId();
  return handleApi(requestId, () => run(requestId));
}
