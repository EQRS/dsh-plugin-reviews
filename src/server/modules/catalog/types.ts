/**
 * catalog 模块对外类型（契约 docs/模块签名契约.md 第 2 节）。
 */

import type { PageRequest, PageResult } from '@/packages/common/result';

/**
 * 收录检查所需的外部探针。
 * 由调用方注入（真实实现走 GitHub API；测试注入 stub），
 * 这样"收录检查"这个核心判定可以在没有网络的情况下被穷尽测试。
 */
export interface CatalogProbe {
  /** 读取仓库基础信息；失败抛 provider_unavailable，未配置抛 provider_not_configured。 */
  fetchRepository(input: { owner: string; repo: string }): Promise<{
    githubRepositoryId: string;
    fullName: string;
    htmlUrl: string;
    isArchived: boolean;
  }>;
  /** 读取插件子目录 package.json 的 dsh.bundle 声明；不存在或未声明返回 null。 */
  fetchPluginManifest(input: { owner: string; repo: string; pluginPath: string }): Promise<{
    bundlePath: string;
    bundleExists: boolean;
  } | null>;
}

export interface AcceptPluginSubmissionInput {
  url: string;
  requestKey: string;
}

export interface AcceptPluginSubmissionResult {
  pluginId: string;
  repositoryId: string;
  /** true = 本次创建了 plugin 行；false = 命中既有 (repository_id, plugin_path)。 */
  created: boolean;
  status: 'accepted';
}

export interface PluginView {
  pluginId: string;
  pluginPath: string;
  /** 收录时间。 */
  createdAt: number;
  updatedAt: number;
  repository: {
    repositoryId: string;
    githubRepositoryId: string;
    fullName: string;
    htmlUrl: string;
    isArchived: boolean;
    availabilityState: 'unknown' | 'available' | 'unavailable';
    lastCheckedAt: number | null;
    lastSuccessfulCheckAt: number | null;
  };
}

export interface PluginSummary {
  pluginId: string;
  pluginPath: string;
  repositoryFullName: string;
  repositoryHtmlUrl: string;
  isArchived: boolean;
  updatedAt: number;
}

export interface CatalogService {
  parseSubmissionUrl(url: string): { owner: string; repo: string; pluginPath: string } | { error: string };
  acceptPluginSubmission(
    ctx: CallerContextLike,
    input: AcceptPluginSubmissionInput,
    deps: { probe: CatalogProbe },
  ): Promise<AcceptPluginSubmissionResult>;
  getPlugin(pluginId: string): Promise<PluginView | null>;
  listPlugins(req: PageRequest): Promise<PageResult<PluginSummary>>;
}

/** 仅需 userId 的最小上下文形状；避免 catalog 依赖不必要的字段。 */
export interface CallerContextLike {
  userId: string | null;
  accountStatus: 'active' | 'disabled' | null;
  role?: 'user' | 'admin' | null;
}
