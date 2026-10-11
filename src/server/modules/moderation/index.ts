/**
 * moderation 模块公共出口（架构第 67.2 节：每个业务模块提供明确的公共入口）。
 *
 * 与 tasks / operations 一致：对外只暴露工厂与单例访问器，
 * 调用方不必深入 `service.ts`，实现文件位置变化时不受影响。
 */

export {
  createModerationService,
  moderationService,
  resetModerationService,
  isVersionResolved,
  evaluateRules,
} from './service';

export type {
  ModerationService,
  ModerationOptions,
  ModerationStage,
  RuleCheckOutcome,
} from './service';
