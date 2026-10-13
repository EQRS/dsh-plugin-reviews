/**
 * 探针桩的构造器（迁移 0005 之后新增）。
 *
 * 背景：`CatalogProbe.fetchRepository` / `fetchPluginManifest` 除了"收录判定"必需的字段，
 * 还要返回一批**展示字段**（简介 / topics / 作者 / 清单版本 / 仓库更新时间）。
 * 绝大多数测试只关心收录判定，不该为此在每个桩里手写一堆 `null` ——
 * 但也不该把契约改成可选（那会让"适配器忘了返回展示字段"这种真实缺陷溜过去）。
 *
 * 所以：**契约保持严格，测试用这里的 helper 补默认值**。要让某个用例覆盖展示字段，
 * 传 overrides 即可。
 */

import type { CatalogProbe } from '@/server/modules/catalog/types';

type RepoInfo = Awaited<ReturnType<CatalogProbe['fetchRepository']>>;
type ManifestInfo = NonNullable<Awaited<ReturnType<CatalogProbe['fetchPluginManifest']>>>;

/** 仓库信息的默认值：判定必需字段给定，展示字段一律"没有"。 */
export function repoInfoStub(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    githubRepositoryId: '9001',
    fullName: 'owner/repo',
    htmlUrl: 'https://github.com/owner/repo',
    isArchived: false,
    description: null,
    topics: [],
    ownerLogin: null,
    ownerAvatarUrl: null,
    repoUpdatedAt: null,
    ...overrides,
  };
}

/** 清单信息的默认值：默认"声明了且文件存在"，展示字段为空。 */
export function manifestStub(overrides: Partial<ManifestInfo> = {}): ManifestInfo {
  return {
    bundlePath: 'dsh.bundle.json',
    bundleExists: true,
    name: null,
    description: null,
    author: null,
    version: null,
    ...overrides,
  };
}
