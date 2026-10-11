/**
 * 请求调用上下文（架构第 23、66、67 节）。
 *
 * 角色与账户状态**每次请求从数据库读取**，不缓存在会话里：
 * 撤销管理员后，其普通登录会话不因此获得旧管理权限。
 */

import { DomainError, err } from '@/packages/common/errors';

export interface CallerContext {
  /** 站内用户 ID；匿名访问为 null。 */
  userId: string | null;
  role: 'user' | 'admin' | null;
  accountStatus: 'active' | 'disabled' | null;
}

export const anonymousContext: CallerContext = { userId: null, role: null, accountStatus: null };

export function isAuthenticated(ctx: CallerContext): boolean {
  return ctx.userId !== null;
}

export function isAdmin(ctx: CallerContext): boolean {
  return ctx.userId !== null && ctx.role === 'admin' && ctx.accountStatus === 'active';
}

/**
 * 写入操作前置校验：登录 + 账户正常。
 * 禁用账户不阻止匿名浏览，但阻止登录后的写入。
 *
 * ⚠️ 必须抛 `DomainError`（而不是裸 `Error`）：HTTP 层按错误码映射状态码，
 * 裸 Error 会被折成 500/internal，把「未登录」和「账户禁用」误报成服务器故障。
 */
export function assertCanWrite(
  ctx: CallerContext,
): asserts ctx is CallerContext & { userId: string; accountStatus: 'active' } {
  if (ctx.userId === null) {
    throw err.unauthenticated();
  }
  if (ctx.accountStatus !== 'active') {
    throw err.disabled();
  }
}

/** 管理员操作前置校验。 */
export function assertCanAdmin(
  ctx: CallerContext,
): asserts ctx is CallerContext & { userId: string; role: 'admin'; accountStatus: 'active' } {
  assertCanWrite(ctx);
  if (ctx.role !== 'admin') {
    throw err.forbidden('该操作需要管理员权限。');
  }
}

/** 判定某个抛出物是否是本模块合法的鉴权错误（供接口层与测试使用）。 */
export function isAuthError(e: unknown): e is DomainError {
  return e instanceof DomainError && (e.code === 'unauthenticated' || e.code === 'account_disabled' || e.code === 'forbidden');
}
