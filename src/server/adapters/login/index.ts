/**
 * 登录适配器（工作包 GI）。
 *
 * 铁律（架构第 11 节 / 错误码 provider_not_configured）：
 * **未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 时必须抛 err.notConfigured(...)，
 * 绝不伪装可用**，也绝不返回假身份把用户"登录"进去。
 *
 * 本文件只负责"把一个 OAuth 回调变成已确认的外部身份"，
 * 站内用户建立与会话建立由 identity 模块完成（职责分离，便于测试注入桩身份）。
 */

import { err } from '@/packages/common/errors';
import type { IdentifiedGithubUser } from '@/server/modules/identity/types';

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface LoginAdapter {
  /** 适配器名称，用于日志与测试断言，避免"看起来调用了真 GitHub"。 */
  readonly kind: 'github' | 'test';
  /** 是否真的具备可用配置（未配置时 false，且 authorize/exchange 必须抛错）。 */
  isConfigured(): boolean;
  /** 生成 GitHub 授权地址。未配置抛 provider_not_configured。 */
  buildAuthorizeUrl(state: string, codeChallenge: string): string;
  /** 用回调 code 换取已确认身份。未配置抛 provider_not_configured。 */
  exchangeCodeForIdentity(input: { code: string; codeVerifier: string }): Promise<IdentifiedGithubUser>;
}

/** 从环境变量读取 GitHub OAuth 配置；任一缺失即视为未配置。 */
export function readGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubOAuthConfig | null {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const redirectUri = env.GITHUB_REDIRECT_URI?.trim() ?? '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

/**
 * GitHub 真实适配器骨架。
 *
 * 说明（不掩盖未完成的部分）：令牌交换与 /user 拉取需要出网，本切片不在服务内直连，
 * 因此 `exchangeCodeForIdentity` 在**已配置**时会抛 provider_unavailable 并说明原因，
 * 而不是返回伪造身份。未配置时抛 provider_not_configured。
 * 这个骨架存在的意义正是：让"未配置"与"已配置但未接通"两种情况都无法悄悄放行登录。
 */
export function createGithubLoginAdapter(config: GithubOAuthConfig | null = readGithubConfig()): LoginAdapter {
  function requireConfig(): GithubOAuthConfig {
    if (!config) {
      throw err.notConfigured(
        '未配置 GitHub 登录（缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET），该登录方式不可用。',
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
        scope: 'read:user',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },

    async exchangeCodeForIdentity(input: { code: string; codeVerifier: string }): Promise<IdentifiedGithubUser> {
      requireConfig();
      if (typeof input.code !== 'string' || input.code.trim().length === 0) {
        throw err.input('缺少授权码。');
      }
      if (typeof input.codeVerifier !== 'string' || input.codeVerifier.trim().length === 0) {
        throw err.input('缺少 PKCE code_verifier。');
      }
      // 已配置但尚未接通真实网络调用：明确报故障，不返回假身份。
      throw err.providerDown(
        'GitHub 令牌交换尚未接通：已配置凭据，但本切片未实现出网调用。请勿据此判断登录成功。',
      );
    },
  };
}

/** NODE_ENV 是否为 test。 */
export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test';
}

/**
 * 测试/本地演示登录适配器。
 *
 * 纪律：仅在 NODE_ENV=test 下可用；生产环境构造时直接抛错，
 * 防止"测试适配器被误接到真实登录入口"这类最危险的错误。
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
      // 测试适配器"已配置"的含义是：桩身份已给定，可以直接完成登录闭环。
      return true;
    },

    buildAuthorizeUrl(state: string, codeChallenge: string): string {
      if (typeof state !== 'string' || state.trim().length === 0) {
        throw err.input('缺少 OAuth state，不能发起授权。');
      }
      if (typeof codeChallenge !== 'string' || codeChallenge.trim().length === 0) {
        throw err.input('缺少 PKCE code_challenge，不能发起授权。');
      }
      return `test-login://authorize?state=${encodeURIComponent(state)}`;
    },

    async exchangeCodeForIdentity(input: { code: string; codeVerifier: string }): Promise<IdentifiedGithubUser> {
      if (typeof input.code !== 'string' || input.code.trim().length === 0) {
        throw err.input('缺少授权码。');
      }
      // 直接回传桩身份，供测试与本地演示；不读网络。
      return { ...stubIdentity };
    },
  };
}
