/**
 * 会话 Cookie 工具（依赖与 Linux 部署第 5 节）。
 *
 * 规则：
 *  - 生产使用 `__Host-dsh_session`：前缀要求 Secure + Path=/ + 无 Domain，
 *    浏览器**只允许**在 HTTPS 下生效；
 *  - 本地开发是 http，浏览器与 curl 都会拒收 `__Host-` + 非 Secure 的 Cookie
 *    （这正是"登录成功但会话立刻丢失"的真实原因），因此开发环境改用不带前缀的名字，
 *    并同样保持 HttpOnly / SameSite=Lax / Path=/；
 *  - 库里只存摘要，Cookie 只携带不可预测凭证。
 *
 * ⚠️ 这个"环境切换"是**刻意的**，不是偷懒：若在 http 下坚持 `__Host-`，
 * 表现为登录接口返回 200 但下一次请求就是匿名，极难排查。
 */

import { cookies } from 'next/headers';

/** 生产 Cookie 名（带 __Host- 前缀，必须 Secure + Path=/ + 无 Domain）。 */
export const SESSION_COOKIE_PROD = '__Host-dsh_session';
/** 开发 Cookie 名：http 下不能用 __Host- 前缀。 */
export const SESSION_COOKIE_DEV = 'dsh_session_dev';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SECURE = IS_PRODUCTION;

/** 当前环境实际使用的 Cookie 名。 */
export function sessionCookieName(): string {
  return IS_PRODUCTION ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 绝对上限 30 天（架构第 105 节）

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  const name = sessionCookieName();
  // 兼容：本地曾用生产名写入过的环境，读时两个都尝试。
  return store.get(name)?.value ?? store.get(SESSION_COOKIE_PROD)?.value ?? store.get(SESSION_COOKIE_DEV)?.value ?? null;
}

export async function writeSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  for (const name of [sessionCookieName(), SESSION_COOKIE_PROD, SESSION_COOKIE_DEV]) {
    store.set(name, '', {
      httpOnly: true,
      secure: SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  }
}
