/**
 * 插件目录的**自动发现**（后台任务 `plugin_discovery` 的业务实现）。
 *
 * 一轮发现做三件事：
 *   1. 搜候选仓库（`topic:dsh-plugin` 之类）；
 *   2. 逐仓库读出"声明了 dsh.bundle"的插件路径；
 *   3. 逐条走**与用户提交完全相同**的收录检查与入库（`acceptPluginSubmissionBySystem`），
 *      审计记 `actor_kind='system'` 并带上触发它的任务 ID。
 *
 * 三条纪律（都是刻意的）：
 *
 * * **发现 ≠ 收录**：本模块不自己判定"这个仓库合不合规"，一律交给 catalog 的收录检查。
 *   发现说"看这个"，收录说"行不行" —— 两者不互相冒充（否则门槛会悄悄变松）。
 * * **不占用户额度**：自动发现走**系统调度预算**（参数与管理规则.md 第 29 行），
 *   既不消耗某个用户的 10 次/时，也不受它限制；但它有**自己的**上游预算（见 DISCOVERY_DEFAULTS），
 *   超额就如实截断（`truncated: true`），不假装"本轮就只有这么多"。
 * * **单条失败不掀桌**：某个仓库读不了（404/归档/没声明 dsh.bundle）只记进 `skipped` 并继续，
 *   只有**探针整体故障**（provider_unavailable）才认为本轮失败 —— 那是"网络/上游坏了"，
 *   不该把 20 个仓库的失败当成 20 个插件的问题。
 */

import { isDomainError } from '@/packages/common/errors';
import type { SqliteDatabase } from '@/server/platform/db';
import { log } from '@/server/platform/log';
import { formatDate } from '@/packages/common/time';
import type { CatalogProbe } from './types';
import type { PluginDiscoveryPort } from '@/server/adapters/catalog/github-discovery';
import { createCatalogService } from './service';

/**
 * 一轮发现的默认预算（**上游**预算，不是用户额度）。
 *
 * 取值理由：GitHub 搜索接口认证后 30 次/分，核心接口 5000 次/时。
 * 一轮典型开销 ≈ 搜索 1-2 次 + 每仓库 (1 次 tree + N 次 package.json) + 每收录 3 次。
 * 默认 12 个候选仓库 / 30 个插件 / 400 次请求，足够一天一轮，也不会贴到上游限流线。
 */
export const DISCOVERY_DEFAULTS = {
  query: 'topic:dsh-plugin',
  searchPages: 2,
  perPage: 30,
  maxCandidates: 12,
  maxPlugins: 30,
  maxRequests: 400,
} as const;

/**
 * 按"有没有 GitHub token"选上游预算。
 *
 * 为什么必须分档：**未认证**访问 GitHub 的核心接口只有 **60 次/小时**（认证后 5000 次/小时）。
 * 一轮发现的典型开销 ≈ 每仓库 2-3 次 + 每个收录 3 次，30 个插件的预算在未认证下必然撞 403。
 * 与其撞上限流再失败，不如按配额给预算：小步走、当天多走几轮。
 *
 * （想要一次导得多，就在服务器 `.env.local` 里加一个**只读**的 `GITHUB_TOKEN` —— 见 deploy/README.md。）
 */
export function discoveryBudgetFor(env: Record<string, string | undefined>): {
  searchPages: number;
  perPage: number;
  maxCandidates: number;
  maxPlugins: number;
  maxRequests: number;
} {
  const authenticated = (env.GITHUB_TOKEN ?? '').trim().length > 0;
  return authenticated
    ? {
        searchPages: DISCOVERY_DEFAULTS.searchPages,
        perPage: DISCOVERY_DEFAULTS.perPage,
        maxCandidates: DISCOVERY_DEFAULTS.maxCandidates,
        maxPlugins: DISCOVERY_DEFAULTS.maxPlugins,
        maxRequests: DISCOVERY_DEFAULTS.maxRequests,
      }
    : {
        // 未认证：**搜索**是独立配额（匿名 10 次/分，一次能拿 30 个候选），便宜；
        // 真正的瓶颈是**核心接口**（仓库树/清单文件）60 次/小时。
        // 所以搜索给足、核心请求压在 58 次以内，让每一轮把小时配额吃满而不撞墙。
        searchPages: 2,
        perPage: 30,
        maxCandidates: 10,
        maxPlugins: 12,
        maxRequests: 58,
      };
}

export interface DiscoveryRunInput {
  /** 本轮审计键前缀：定时任务用"当天日期"，手动触发用 requestKey。 */
  runKey: string;
  /** 触发它的后台任务（写进 operation_records.task_id）。 */
  taskId: string | null;
  query?: string;
  searchPages?: number;
  perPage?: number;
  maxCandidates?: number;
  maxPlugins?: number;
  maxRequests?: number;
}

export interface DiscoverySkip {
  url: string;
  /** 失败码（DomainError 的 code）或 `discovery_*` 自定码。 */
  code: string;
  reason: string;
}

export interface DiscoveryRunSummary {
  runKey: string;
  query: string;
  searchedRepos: number;
  truncated: boolean;
  truncatedReason: string | null;
  pluginsFound: number;
  accepted: number;
  created: number;
  refreshed: number;
  skipped: DiscoverySkip[];
  requestsUsed: number;
}

export interface PluginDiscoveryService {
  run(input: DiscoveryRunInput): Promise<DiscoveryRunSummary>;
}

/** 定时任务的"哪一天"按站点展示时区（Asia/Shanghai）算，避免服务器时区一变就跨两轮。 */
export function discoveryDailyKey(now: number): string {
  return `daily:${formatDate(now).replace(/\//g, '-')}`;
}

/**
 * 明显"不是给用户装的插件"的路径（测试夹具 / 示例 / e2e）：发现阶段跳过，并如实记一笔。
 *
 * 这是**候选筛选**（启发式），不是收录判定 —— 收录判定只认"声明了 dsh.bundle 且文件在"。
 * 真实踩过：`vlln/dsh-autofork` 的 `tests/e2e/slow-tool-plugin` 被当成插件收进了线上目录，
 * 页面上多出一个测试夹具（用户会以为那是能装的插件）。
 * 根目录（pluginPath === '.'）永不匹配，避免把"仓库本身就是插件"误杀。
 */
const NON_SHIPPABLE_PATH = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|examples?|e2e)(\/|$)/i;

export function createPluginDiscoveryService(deps: {
  db: SqliteDatabase;
  discovery: PluginDiscoveryPort;
  probe: CatalogProbe;
}): PluginDiscoveryService {
  const catalog = createCatalogService({ db: deps.db });

  /** 上游限流：重试无用，要**干净收尾**（保住已收录的），不能把整轮当故障丢掉。 */
  const isUpstreamRateLimit = (e: unknown): boolean =>
    isDomainError(e) && e.code === 'provider_unavailable' && deps.discovery.wasRateLimited();

  return {
    async run(input) {
      const query = input.query ?? DISCOVERY_DEFAULTS.query;
      const maxCandidates = input.maxCandidates ?? DISCOVERY_DEFAULTS.maxCandidates;
      const maxPlugins = input.maxPlugins ?? DISCOVERY_DEFAULTS.maxPlugins;
      const maxRequests = input.maxRequests ?? DISCOVERY_DEFAULTS.maxRequests;

      const skipped: DiscoverySkip[] = [];
      let accepted = 0;
      let created = 0;
      let refreshed = 0;
      let pluginsFound = 0;
      let candidates: Awaited<ReturnType<PluginDiscoveryPort['searchCandidates']>> = [];
      let truncated = false;
      let truncatedReason: string | null = null;

      try {
        candidates = await deps.discovery.searchCandidates({
          query,
          pages: input.searchPages ?? DISCOVERY_DEFAULTS.searchPages,
          perPage: input.perPage ?? DISCOVERY_DEFAULTS.perPage,
        });
      } catch (e) {
        if (isUpstreamRateLimit(e)) {
          // 连搜索都被限流：本轮什么都没做。**如实返回"没做"**而不是抛错重试，
          // 因为重试（30s/120s）改变不了配额，只会白烧三次尝试。
          log.warn('发现被上游限流：搜索阶段就受限，本轮无事发生', { run_key: input.runKey, query });
          return {
            runKey: input.runKey,
            query,
            searchedRepos: 0,
            truncated: true,
            truncatedReason: '上游限流（HTTP 403）：配额耗尽，本轮未发现任何候选，等配额恢复后再跑。',
            pluginsFound: 0,
            accepted: 0,
            created: 0,
            refreshed: 0,
            skipped: [],
            requestsUsed: deps.discovery.requestsUsed(),
          };
        }
        // 其它上游故障：**整轮失败**（任务层会重试），不当成"零发现"。
        log.error('发现失败：搜索候选仓库时上游不可用', {
          run_key: input.runKey,
          query,
          code: isDomainError(e) ? e.code : 'unknown',
          error: e instanceof Error ? e.message : 'unknown',
        });
        throw e;
      }

      const picked = candidates.slice(0, maxCandidates);
      if (candidates.length > picked.length) {
        truncated = true;
        truncatedReason = `候选仓库超过单轮上限（${candidates.length} > ${maxCandidates}）`;
      }

      /** 逐仓库读插件路径；单仓库失败只记一笔。 */
      for (const candidate of picked) {
        if (accepted >= maxPlugins || deps.discovery.requestsUsed() >= maxRequests) {
          truncated = true;
          truncatedReason =
            accepted >= maxPlugins
              ? `已达单轮收录上限（${maxPlugins} 个）`
              : `已达单轮上游请求上限（${maxRequests} 次）`;
          break;
        }
        let found: Awaited<ReturnType<PluginDiscoveryPort['findPlugins']>> = [];
        try {
          found = await deps.discovery.findPlugins(candidate);
        } catch (e) {
          if (isUpstreamRateLimit(e)) {
            // 配额用尽：**干净收尾**（已收录的都在库里），不把整轮当故障。
            truncated = true;
            truncatedReason = '上游限流（HTTP 403）：配额耗尽，本轮到此为止，已收录的条目都保留。';
            break;
          }
          if (isDomainError(e) && e.code === 'provider_unavailable') {
            // 其它上游故障：整轮失败（继续跑只会把剩余候选也撞成同一错误）。
            log.error('发现失败：读取仓库清单时上游不可用', {
              run_key: input.runKey,
              repo: candidate.fullName,
              error: e.message,
            });
            throw e;
          }
          skipped.push({
            url: candidate.htmlUrl,
            code: isDomainError(e) ? e.code : 'discovery_repo_unreadable',
            reason: e instanceof Error ? e.message : '读取仓库清单失败',
          });
          continue;
        }
        if (found.length === 0) {
          // 不是错误：很多带 dsh 主题的仓库并不是插件（或声明缺失），如实记一笔便于复核。
          skipped.push({
            url: candidate.htmlUrl,
            code: 'discovery_no_dsh_bundle',
            reason: '仓库里没有 package.json 声明 dsh.bundle',
          });
          continue;
        }

        for (const plugin of found) {
          if (accepted >= maxPlugins || deps.discovery.requestsUsed() >= maxRequests) {
            truncated = true;
            truncatedReason =
              accepted >= maxPlugins
                ? `已达单轮收录上限（${maxPlugins} 个）`
                : `已达单轮上游请求上限（${maxRequests} 次）`;
            break;
          }
          // 测试夹具 / 示例不进目录（发现阶段筛选；如实记一笔而不是悄悄丢掉）
          if (plugin.pluginPath !== '.' && NON_SHIPPABLE_PATH.test(plugin.pluginPath)) {
            skipped.push({
              url: plugin.url,
              code: 'discovery_non_shippable_path',
              reason: `路径像测试/示例（${plugin.pluginPath}），不作为可安装插件收录`,
            });
            continue;
          }
          pluginsFound += 1;
          try {
            const result = await catalog.acceptPluginSubmissionBySystem(
              {
                url: plugin.url,
                // 每轮的审计键都不同：发现的每一轮都该留自己的账（任务层按天去重保证一天只跑一轮）。
                operationKey: `discover:${input.runKey}:${candidate.fullName}:${plugin.pluginPath}`,
                taskId: input.taskId,
                reason: `自动发现收录（${DISCOVERY_DEFAULTS.query}，第 ${input.runKey} 轮）。`,
              },
              { probe: deps.probe },
            );
            accepted += 1;
            if (result.created) created += 1;
            else refreshed += 1;
          } catch (e) {
            const code = isDomainError(e) ? e.code : 'unknown';
            if (isUpstreamRateLimit(e)) {
              truncated = true;
              truncatedReason = '上游限流（HTTP 403）：配额耗尽，本轮到此为止，已收录的条目都保留。';
              break;
            }
            if (code === 'provider_unavailable') {
              log.error('发现失败：收录检查时上游不可用', {
                run_key: input.runKey,
                url: plugin.url,
                error: e instanceof Error ? e.message : 'unknown',
              });
              throw e;
            }
            skipped.push({
              url: plugin.url,
              code,
              reason: e instanceof Error ? e.message : '收录被拒',
            });
          }
        }
      }

      const summary: DiscoveryRunSummary = {
        runKey: input.runKey,
        query,
        searchedRepos: candidates.length,
        truncated,
        truncatedReason,
        pluginsFound,
        accepted,
        created,
        refreshed,
        skipped,
        requestsUsed: deps.discovery.requestsUsed(),
      };
      log.info('自动发现一轮结束', {
        run_key: summary.runKey,
        query: summary.query,
        searched_repos: summary.searchedRepos,
        plugins_found: summary.pluginsFound,
        accepted: summary.accepted,
        created: summary.created,
        refreshed: summary.refreshed,
        skipped: summary.skipped.length,
        requests_used: summary.requestsUsed,
        truncated: summary.truncated,
        truncated_reason: summary.truncatedReason,
      });
      return summary;
    },
  };
}
