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
 *
 * ## 第三种情况：生产但**没有 TLS**（例如先用 `http://<IP>` 试跑）
 *
 * 这时 `NODE_ENV=production` 反而会把 Cookie 写成 `Secure` + `__Host-`，
 * 浏览器照样拒收 —— 同一个坑换了个触发方式。所以由 `DSH_REVIEW_INSECURE_COOKIES=1`
 * **显式**声明"我知道现在没有 TLS"，此时回退到开发那套（不带前缀、不带 Secure）。
 * 它不会让站点变得安全，只是让"先跑起来"成为可能；上 HTTPS 后**必须**去掉这个变量。
 */

import { cookies } from 'next/headers';

/** 生产 Cookie 名（带 __Host- 前缀，必须 Secure + Path=/ + 无 Domain）。 */
export const SESSION_COOKIE_PROD = '__Host-dsh_session';
/** 开发 Cookie 名：http 下不能用 __Host- 前缀。 */
export const SESSION_COOKIE_DEV = 'dsh_session_dev';

export interface CookieMode {
  /** 是否处于生产环境（NODE_ENV=production）。 */
  isProduction: boolean;
  /** 是否因为"没有 TLS"而显式降级（需要人来处理，不是正常状态）。 */
  insecureOverride: boolean;
  /** 是否给 Cookie 加 Secure（同时决定用不用 `__Host-` 前缀）。 */
  secure: boolean;
  /** 实际使用的 Cookie 名。 */
  name: string;
}

/**
 * 纯函数：把"环境 + 显式声明"映射成 Cookie 策略。抽出来是为了能直接测四个组合，
 * 而不是靠改进程环境再动态 import。
 */
export function resolveCookieMode(env: NodeJS.ProcessEnv | Record<string, string | undefined>): CookieMode {
  const isProduction = env.NODE_ENV === 'production';
  const insecureOverride = (env.DSH_REVIEW_INSECURE_COOKIES ?? '').trim() === '1' && isProduction;
  const secure = isProduction && !insecureOverride;
  return {
    isProduction,
    insecureOverride,
    secure,
    // 注意：判断依据是 `secure` 而不是"是不是生产" —— 两者在降级时不等价。
    name: secure ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV,
  };
}

const MODE = resolveCookieMode(process.env);

if (MODE.insecureOverride) {
  // 模块级只打一次。这行是给人看的：别忘了上 TLS。
  console.warn(
    '[安全] DSH_REVIEW_INSECURE_COOKIES=1：本进程跑在**没有 TLS** 的地址上，会话 Cookie 不加密传输，' +
      '链路上任何能监听的人都可以直接拿走它。上 HTTPS 后请立刻去掉这个变量。',
  );
}

/** 当前进程实际采用的 Cookie 策略（只读，供诊断用）。 */
export function cookieMode(): CookieMode {
  return MODE;
}

/** 当前环境是否给 Cookie 加 Secure。OAuth 的浏览器绑定 Cookie 也用它，别各写各的。 */
export function cookieSecure(): boolean {
  return MODE.secure;
}

/** 当前环境实际使用的 Cookie 名。 */
export function sessionCookieName(): string {
  return MODE.name;
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
    secure: cookieSecure(),
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
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  }
}
