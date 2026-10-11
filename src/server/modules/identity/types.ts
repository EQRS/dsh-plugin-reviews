/**
 * identity 模块对外类型（见 docs/模块签名契约.md 第 1 节）。
 *
 * 纪律：模块只导出服务对象与这些类型，不导出仓储、表定义或 SQL。
 */

import type { CallerContext } from '@/server/platform/context';

/** GitHub 回调已确认的外部身份（由 adapters/login 产出）。 */
export interface IdentifiedGithubUser {
  /** GitHub 稳定 ID（文本）。数字 ID 也要转成文本，不能退化成用户名。 */
  providerUserId: string;
  providerUsername: string;
  profileUrl: string;
  avatarUrl: string | null;
  displayName: string | null;
}

export interface SignInResult {
  userId: string;
  /** true = 本次回调新建了站内用户；false = 复用既有用户。 */
  created: boolean;
}

export interface CreatedSession {
  sessionId: string;
  /**
   * 明文凭证。**只用于写入受保护 Cookie**；
   * 数据库只保存 digestText(token)，调用方不得把它写进日志或审计记录。
   */
  token: string;
  expiresAt: number;
  absoluteExpiresAt: number;
}

/** resolveSession 的返回：调用上下文 + 本次命中的会话 ID。 */
export type ResolvedSession = CallerContext & { userId: string; role: 'user' | 'admin'; accountStatus: 'active' | 'disabled'; sessionId: string };

/** 会话时限参数（架构第 105 节）。集中一处，便于日后改配置时只动这里。 */
export interface SessionPolicy {
  validityDays: number;
  absoluteLifetimeDays: number;
  renewIntervalHours: number;
  activityWriteIntervalSeconds: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  validityDays: 7,
  absoluteLifetimeDays: 30,
  renewIntervalHours: 24,
  activityWriteIntervalSeconds: 300,
};

export interface IdentityService {
  /** 首次登录自动建站内用户；**同一 GitHub 稳定 ID 重复回调复用既有用户，不重复创建**。 */
  signInWithGithub(input: IdentifiedGithubUser, now: number): Promise<SignInResult>;
  /** 建立本站会话，返回明文凭证（仅用于 Cookie，库里只存摘要）。 */
  createSession(userId: string, now: number): Promise<CreatedSession>;
  /** 按明文凭证解析当前调用上下文；无效/过期/撤销/禁用返回 null。 */
  resolveSession(token: string, now: number): Promise<ResolvedSession | null>;
  /** 有效访问触发续期（按 renew_interval_hours 与 absolute 上限）。 */
  touchSession(sessionId: string, now: number): Promise<void>;
  revokeSession(sessionId: string, now: number): Promise<void>;
  /** 资料确认页保存（昵称、头像），可跳过。 */
  updateProfile(ctx: CallerContext, input: { nickname?: string; avatarUrl?: string | null }): Promise<void>;
}
