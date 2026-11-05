/**
 * 接口层共用工具：把当前会话解析成调用上下文、统一包装响应。
 *
 * 规则（架构第 65、88 节）：
 *  - 响应统一 `{ ok, data|error, request_id }`；
 *  - 未登录/禁用返回正确状态码（401/403），不是 500；
 *  - `request_id` 只用于日志关联，不替代 `request_key`。
 */

import type { CallerContext } from '@/server/platform/context';
import { anonymousContext } from '@/server/platform/context';
import { getDb } from '@/server/platform/db';
import { createIdentityService } from '@/server/modules/identity';
import { readSessionToken } from '@/server/platform/session-cookie';
import { requestIdFromHeaders } from '@/server/platform/request-id';
import { jsonOk, errorResponse } from '@/server/platform/errors-http';
import { booleanSetting } from '@/server/modules/settings';
import { err } from '@/packages/common/errors';

/** 从 Cookie 解析当前调用上下文；无会话或失效即匿名。角色每次从库读。 */
export async function currentContext(): Promise<CallerContext> {
  const token = await readSessionToken();
  if (!token) return anonymousContext;
  const identity = createIdentityService({ db: getDb() });
  const resolved = await identity.resolveSession(token, Date.now());
  if (!resolved) return anonymousContext;
  return { userId: resolved.userId, role: resolved.role, accountStatus: resolved.accountStatus };
}

/**
 * 讨论区总开关（`forum.enabled`）：关闭时接口一律 404。
 *
 * 口径来源（PR-讨论区.md「已知取舍」第 2 条、「设计-讨论区与收藏重构」§开关）：
 * 未开放的功能对外表现为**不存在**，而不是「无权限」——
 * 所以用 `err.unavailable`（404 target_unavailable）而不是 `err.forbidden`（403）。
 * 页面侧同一口径见 src/app/forum 下的 `notFound()`。
 *
 * 每个 handler 第一步调用：开关判断必须先于鉴权与读 body，
 * 否则关站期间匿名用户仍能从 401/400 的差异里探出接口存在。
 */
export function assertForumEnabled(): void {
  if (!booleanSetting(getDb(), 'forum.enabled', true)) {
    throw err.unavailable('讨论区当前未开放。');
  }
}

/** 读取 request_id：优先复用入站请求头，便于跨服务追踪。 */
export function requestMeta(request: Request): { requestId: string } {
  return { requestId: requestIdFromHeaders(request.headers) };
}

/** 成功响应包装。 */
export function okJson<T>(data: T, requestId: string, status = 200): Response {
  return jsonOk(data, requestId, status);
}

export { errorResponse };

/** 解析 JSON 请求体；坏 JSON 抛 input_invalid（由统一错误层映射 400）。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    const { err } = await import('@/packages/common/errors');
    throw err.input('请求体不是合法 JSON。');
  }
}
