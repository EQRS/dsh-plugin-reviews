/**
 * 接口结果与分页结构（架构第 64、65 节）。
 *
 * 约定：
 *  - 成功返回 `{ ok: true, data, request_id }`；
 *  - 失败返回 `{ ok: false, error, request_id }`；
 *  - `request_id` 由服务端生成，仅用于关联日志，**不能**替代 `request_key`（用户操作去重）
 *    或 `operation_key`（业务审计去重）。
 */

import type { BusinessError } from './errors';

export interface OkResult<T> {
  ok: true;
  data: T;
  request_id: string;
}

export interface FailResult {
  ok: false;
  error: BusinessError;
  request_id: string;
}

export type ApiResult<T> = OkResult<T> | FailResult;

export function ok<T>(data: T, requestId: string): OkResult<T> {
  return { ok: true, data, request_id: requestId };
}

export function fail(error: BusinessError, requestId: string): FailResult {
  return { ok: false, error, request_id: requestId };
}

/** 分页请求参数（架构第 64.1 节）：页码从 1 开始。 */
export interface PageRequest {
  page: number;
  page_size: number;
}

/** 分页结果：总数按业务对象统计，不含重复项。 */
export interface PageResult<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_previous: boolean;
  has_next: boolean;
}

/** 分页初始参数（架构第 100 节）。 */
export const PaginationDefaults = {
  default_page_size: 20,
  allowed_page_sizes: [10, 20, 50] as const,
  max_page_size: 50,
} as const;

export function emptyPage<T>(req: PageRequest): PageResult<T> {
  return {
    items: [],
    page: req.page,
    page_size: req.page_size,
    total: 0,
    total_pages: 0,
    has_previous: false,
    has_next: false,
  };
}

export function buildPage<T>(items: T[], total: number, req: PageRequest): PageResult<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / req.page_size);
  return {
    items,
    page: req.page,
    page_size: req.page_size,
    total,
    total_pages: totalPages,
    has_previous: req.page > 1,
    has_next: req.page < totalPages,
  };
}
