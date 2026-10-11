/**
 * 基础设施统一出口。业务模块只从这里拿连接、事务、时间、ID 与摘要能力。
 */
export * from './db';
export * from './tx';
export * from './time';
export * from './id';
export * from './digest';
export * from './log';
export * from './context';
export * from './request-id';
export * from './errors-http';
export { migrate, selfCheck, REQUIRED_TABLES } from './migrate';
export type { SelfCheckResult, MigrateResult } from './migrate';
