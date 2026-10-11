/**
 * identity 模块出口。
 *
 * 只导出服务工厂与对外类型；不导出仓储、表定义或 SQL。
 */

export { createIdentityService } from './service';
export type { IdentityServiceDeps } from './service';
export {
  DEFAULT_SESSION_POLICY,
  type CreatedSession,
  type IdentifiedGithubUser,
  type IdentityService,
  type ResolvedSession,
  type SessionPolicy,
  type SignInResult,
} from './types';
