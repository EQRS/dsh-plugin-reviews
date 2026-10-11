/**
 * 请求追踪标识（架构第 65 节）。
 *
 * `request_id` 由服务端生成，**只用于把一次请求与日志／响应关联起来**，方便用户报错时按追踪号定位。
 *
 * ⚠️ 边界（必须遵守，架构第 65 节原文）：
 * `request_id` **不能**替代以下两个去重键 —— 它们各自表达不同的业务含义，混用会造成真实用户操作被误判为重复，
 * 或者同一操作的多次重试被重复执行：
 *   - `request_key`：**用户操作去重**。由客户端为一次用户意图生成，重试沿用同一键；
 *     落在 `draft_save_receipts(draft_id, request_key)`、`content_submissions(submitted_by, request_key)` 上。
 *   - `operation_key`：**业务审计去重**。由服务端为一次业务变更生成，落在 `operation_records(action_type, operation_key)` 上。
 *
 * 典型错误：把 `request_id` 当作 `request_key` 写库。这样用户刷新页面重试会拿到新的 `request_id`，
 * 于是同一份草稿被重复写入、防重复机制完全失效。**本模块不提供任何去重键的生成能力。**
 */

import { newId } from './id';

/** 对外发出的 `request_id` 响应头，便于对照前端网络面板与服务端日志。 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** 允许从外部带入的 `request_id` 的字符集与长度上限：只接受 URL/头部安全的可见 ASCII。 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/;

/** 生成新的 `request_id`（规范小写 UUIDv7，与站内其他 ID 同一形态）。 */
export function newRequestId(now: number = Date.now()): string {
  return newId(now);
}

/**
 * 判断一个外部传入的值能否安全地当作 `request_id` 沿用。
 *
 * 之所以不直接沿用任意字符串：`request_id` 会进日志与响应头，若允许换行或超长内容，
 * 会造成日志注入或响应头伪造就地生效。
 */
export function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}

/**
 * 读取或生成 `request_id`。
 *
 * 优先沿用上游（网关／代理／客户端）带进来的取值，便于把跨服务的同一次请求串成一条链；
 * 缺失或不安全时生成新的。任何情况下都返回可安全写入日志与响应头的字符串。
 */
export function readRequestId(candidate?: string | null, now: number = Date.now()): string {
  return isSafeRequestId(candidate) ? candidate : newRequestId(now);
}

/**
 * 从 Web `Request` 头部读取或生成 `request_id`。
 *
 * 不读 Cookie，也不依赖任何 Next.js 专有类型，便于在任何运行时下复用。
 */
export function requestIdFromHeaders(headers: Headers, now: number = Date.now()): string {
  return readRequestId(headers.get(REQUEST_ID_HEADER), now);
}

/** 把 `request_id` 写进响应头（与响应体中的 `request_id` 保持一致）。 */
export function withRequestIdHeader(headers: Headers, requestId: string): Headers {
  headers.set(REQUEST_ID_HEADER, requestId);
  return headers;
}
