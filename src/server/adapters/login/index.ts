/**
 * GitHub OAuth 真实实现（架构第 11 节）。
 *
 * 本文件取代原先"已配置也抛 provider_unavailable"的骨架：
 *  - 授权：构造 github.com/login/oauth/authorize（state + S256 PKCE）
 *  - 回调：POST /login/oauth/access_token 换 token → GET /user 取稳定身份
 *
 * 铁律：
 *  1. 未配置凭据 → `provider_not_configured`，**绝不伪装可用**；
 *  2. 出网失败/限流 → `provider_unavailable`，**绝不返回伪造身份**；
 *  3. 只使用 GitHub 稳定账户 ID（数字 id）作为身份标识，用户名可改，不能当身份；
 *  4. 不带 `Accept: application/json` 时 GitHub 会返回表单编码，必须显式要求 JSON。
 */

import { err } from '@/packages/common/errors';
import type { IdentifiedGithubUser } from '@/server/modules/identity/types';

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface LoginAdapter {
  readonly kind: 'github' | 'test';
  isConfigured(): boolean;
  buildAuthorizeUrl(state: string, codeChallenge: string): string;
  exchangeCodeForIdentity(input: { code: string; codeVerifier: string }): Promise<IdentifiedGithubUser>;
}

/** 出网请求超时（架构第 103 节：普通外部资料请求 30 秒）。 */
const REQUEST_TIMEOUT_MS = 30_000;

export function readGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubOAuthConfig | null {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const redirectUri = env.GITHUB_REDIRECT_URI?.trim() ?? '';
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

interface GithubTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface GithubUserResponse {
  id?: unknown;
  login?: unknown;
  name?: unknown;
  avatar_url?: unknown;
  html_url?: unknown;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createGithubLoginAdapter(config: GithubOAuthConfig | null = readGithubConfig()): LoginAdapter {
  function requireConfig(): GithubOAuthConfig {
    if (!config) {
      throw err.notConfigured(
        '未配置 GitHub 登录（缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_REDIRECT_URI），该登录方式不可用。',
      );
    }
    return config;
  }

  return {
    kind: 'github',

    isConfigured(): boolean {
      return config !== null;
    },

    buildAuthorizeUrl(state: string, codeChallenge: string): string {
      const cfg = requireConfig();
      if (typeof state !== 'string' || state.trim().length === 0) {
        throw err.input('缺少 OAuth state，不能发起授权。');
      }
      if (typeof codeChallenge !== 'string' || codeChallenge.trim().length === 0) {
        throw err.input('缺少 PKCE code_challenge，不能发起授权。');
      }
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        // 只索取读取公开资料所需的最小范围（不申请 repo 权限）。
        scope: 'read:user',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },

    async exchangeCodeForIdentity(input): Promise<IdentifiedGithubUser> {
      const cfg = requireConfig();
      if (typeof input.code !== 'string' || input.code.trim().length === 0) {
        throw err.input('缺少授权码。');
      }
      if (typeof input.codeVerifier !== 'string' || input.codeVerifier.trim().length === 0) {
        throw err.input('缺少 PKCE code_verifier。');
      }

      // ---- 1) code + verifier 换 access token ----
      let tokenRes: Response;
      try {
        tokenRes = await fetchWithTimeout('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            // 不带这个头 GitHub 会返回表单编码
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': 'dsh-plugin-review',
          },
          body: JSON.stringify({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            code: input.code,
            redirect_uri: cfg.redirectUri,
            code_verifier: input.codeVerifier,
          }),
        });
      } catch {
        throw err.providerDown('与 GitHub 通信失败（网络或超时），请稍后重试。');
      }

      if (!tokenRes.ok) {
        throw err.providerDown(`GitHub 令牌交换失败（HTTP ${tokenRes.status}），请稍后重试。`);
      }

      let tokenBody: GithubTokenResponse;
      try {
        tokenBody = (await tokenRes.json()) as GithubTokenResponse;
      } catch {
        throw err.providerDown('GitHub 返回了无法解析的令牌响应。');
      }

      if (typeof tokenBody.error === 'string' && tokenBody.error.length > 0) {
        // 授权码无效/已使用/过期：这属于"重新登录"，不是服务器故障。
        throw err.unavailable('GitHub 授权未通过（授权码无效或已使用），请重新登录。');
      }
      const accessToken = tokenBody.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw err.providerDown('GitHub 未返回访问令牌。');
      }

      // ---- 2) 取稳定身份 ----
      let userRes: Response;
      try {
        userRes = await fetchWithTimeout('https://api.github.com/user', {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${accessToken}`,
            'user-agent': 'dsh-plugin-review',
            'x-github-api-version': '2022-11-28',
          },
        });
      } catch {
        throw err.providerDown('与 GitHub 通信失败（网络或超时），请稍后重试。');
      }

      if (userRes.status === 401) {
        throw err.unavailable('GitHub 拒绝了该访问令牌，请重新登录。');
      }
      if (!userRes.ok) {
        throw err.providerDown(`读取 GitHub 用户资料失败（HTTP ${userRes.status}），请稍后重试。`);
      }

      let user: GithubUserResponse;
      try {
        user = (await userRes.json()) as GithubUserResponse;
      } catch {
        throw err.providerDown('GitHub 返回了无法解析的用户资料。');
      }

      // 稳定账户 ID：数字 id 转字符串。用户名可变，**不能**作为身份。
      const idValue = user.id;
      const providerUserId = typeof idValue === 'number' ? String(idValue) : typeof idValue === 'string' ? idValue : '';
      if (providerUserId.trim() === '') {
        throw err.providerDown('GitHub 未返回稳定的账户标识，无法建立登录。');
      }
      const login = typeof user.login === 'string' && user.login.trim() !== '' ? user.login : `gh-${providerUserId}`;

      return {
        providerUserId,
        providerUsername: login,
        profileUrl: typeof user.html_url === 'string' ? user.html_url : `https://github.com/${login}`,
        avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
        displayName: typeof user.name === 'string' && user.name.trim() !== '' ? user.name : login,
      };
    },
  };
}

export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test';
}

/**
 * 测试登录适配器：**只在 NODE_ENV=test 下可用**。
 * 生产环境构造时直接抛错，防止测试通道被误接到真实登录入口。
 */
export function createTestLoginAdapter(
  stubIdentity: IdentifiedGithubUser,
  env: NodeJS.ProcessEnv = process.env,
): LoginAdapter {
  if (!isTestEnvironment(env)) {
    throw err.internal('测试登录适配器只能在 NODE_ENV=test 下使用。');
  }
  if (typeof stubIdentity.providerUserId !== 'string' || stubIdentity.providerUserId.trim().length === 0) {
    throw err.input('测试身份必须提供 providerUserId。');
  }

  return {
    kind: 'test',
    isConfigured(): boolean {
      return true;
    },
    buildAuthorizeUrl(state: string, codeChallenge: string): string {
      if (typeof state !== 'string' || state.trim().length === 0) throw err.input('缺少 OAuth state。');
      if (typeof codeChallenge !== 'string' || codeChallenge.trim().length === 0) throw err.input('缺少 PKCE code_challenge。');
      return `test-login://authorize?state=${encodeURIComponent(state)}`;
    },
    async exchangeCodeForIdentity(input): Promise<IdentifiedGithubUser> {
      if (typeof input.code !== 'string' || input.code.trim().length === 0) throw err.input('缺少授权码。');
      return { ...stubIdentity };
    },
  };
}
