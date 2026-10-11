/**
 * catalog 服务（工作包 GI，契约 docs/模块签名契约.md 第 2 节）。
 *
 * 关键不变量：
 *  1. **收录检查必须真的做**：仓库可访问 **且** package.json 有 `dsh.bundle` 声明
 *     **且** 引用的配置文件存在。任何一条不满足即拒绝，不得"先收录再说"。
 *  2. **按 (repository_id, plugin_path) 幂等**：同一仓库同一子路径重复提交
 *     只产生一个 plugin 行，第二次起 created=false 且返回**原插件 ID**。
 *  3. **request_key 去重**：同键同摘要 → 返回原结果（replayed）；同键不同摘要 →
 *     request_key_reused。
 *  4. **外部探针在事务外调用**：better-sqlite3 是同步驱动，事务内做网络请求会长时间持锁。
 *
 * 关于 request_key 去重的落点（必须说明，否则会被当成"漏了不可变表"）：
 * 本切片基线的三张去重表是 `draft_save_receipts` / `content_submissions` /
 * `operation_records`，它们分别绑定草稿、提交与审计，**没有**通用请求回执表。
 * 而本模块的可写范围不含 migrations/**，不得自行建表。因此这里把同一套语义
 * ——「同键同摘要返回原结果，同键不同摘要报 request_key_reused」——落在
 * `operation_records(action_type, operation_key)` 上：它正是审计去重表，
 * 且 (action_type, operation_key) 是 UNIQUE，天然提供并发下的原子性。
 * 摘要存放在该行的 `changes` JSON 里，用于区分"同键同摘要"与"同键不同摘要"。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { digest } from '@/server/platform/digest';
import { newId } from '@/server/platform/id';
import { err } from '@/packages/common/errors';
import { buildPage, type PageRequest, type PageResult } from '@/packages/common/result';
import { ROOT_PLUGIN_PATH, parseSubmissionUrl } from './parse-url';
import type {
  AcceptPluginSubmissionInput,
  AcceptPluginSubmissionResult,
  CallerContextLike,
  CatalogProbe,
  CatalogService,
  PluginSummary,
  PluginView,
} from './types';

/** operation_records.action_type：收录动作的固定动作名。 */
export const ACCEPT_PLUGIN_ACTION = 'catalog.accept_plugin_submission';

export interface CatalogServiceDeps {
  /** 显式连接（测试用真实临时库）。省略时回退平台单例。 */
  db?: SqliteDatabase;
}

interface RepositoryRow {
  id: string;
  github_repository_id: string;
  full_name: string;
  html_url: string;
  is_archived: number;
  availability_state: 'unknown' | 'available' | 'unavailable';
  last_checked_at: number | null;
  last_successful_check_at: number | null;
}

interface PluginRow {
  id: string;
  repository_id: string;
  plugin_path: string;
  created_at: number;
  updated_at: number;
}

interface OperationRow {
  target_id: string;
  changes: string;
}

export function createCatalogService(deps: CatalogServiceDeps = {}): CatalogService {
  const db: SqliteDatabase = deps.db ?? getDb();

  /** 读取已存在的回执行；返回其记录的摘要。 */
  function receiptDigest(operationKey: string): string | null {
    const row = db
      .prepare('SELECT target_id, changes FROM operation_records WHERE action_type = ? AND operation_key = ?')
      .get(ACCEPT_PLUGIN_ACTION, operationKey) as OperationRow | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.changes) as { request_digest?: unknown };
      return typeof parsed.request_digest === 'string' ? parsed.request_digest : null;
    } catch {
      return null;
    }
  }

  return {
    parseSubmissionUrl,

    async acceptPluginSubmission(
      ctx: CallerContextLike,
      input: AcceptPluginSubmissionInput,
      probeDeps: { probe: CatalogProbe },
    ): Promise<AcceptPluginSubmissionResult> {
      // ---- 前置校验：写操作必须登录且账户正常（DomainError，不是裸 Error）----
      if (ctx == null || ctx.userId === null) throw err.unauthenticated('收录插件需要先登录。');
      if (ctx.accountStatus !== 'active') throw err.disabled();
      if (typeof input.requestKey !== 'string' || input.requestKey.trim().length === 0) {
        throw err.input('缺少请求标识。', [{ path: 'request_key', message: '必填且不能为纯空白。' }]);
      }
      if (probeDeps == null || probeDeps.probe == null) {
        // 没有探针就无法完成"收录检查"。此时**不能**放行，否则等于关掉收录门槛。
        throw err.notConfigured('未提供 GitHub 探针，无法完成收录检查。');
      }
      const probe = probeDeps.probe;

      const parsed = parseSubmissionUrl(input.url);
      if ('error' in parsed) {
        throw err.input(parsed.error, [{ path: 'url', message: parsed.error }]);
      }

      // ---- 请求去重（第一步）：同键同摘要 → 原结果；同键不同摘要 → 冲突 ----
      const requestDigest = digest({ url: parsed, operation: ACCEPT_PLUGIN_ACTION });
      const priorDigest = receiptDigest(input.requestKey);
      if (priorDigest !== null) {
        if (priorDigest !== requestDigest) {
          throw err.keyReused('同一请求标识已被用于另一次收录提交。');
        }
        const replay = db
          .prepare('SELECT target_type, target_id FROM operation_records WHERE action_type = ? AND operation_key = ?')
          .get(ACCEPT_PLUGIN_ACTION, input.requestKey) as { target_type: string; target_id: string } | undefined;
        // target_type 形如 'plugin:<repositoryId>'，重放时据此还原原结果。
        if (replay) {
          const separator = replay.target_type.indexOf(':');
          const repositoryId = separator >= 0 ? replay.target_type.slice(separator + 1) : '';
          return { pluginId: replay.target_id, repositoryId, created: false, status: 'accepted' };
        }
      }

      // ---- 收录检查（事务外：网络调用不得占用写事务）----
      // 1) 仓库可访问
      const repoInfo = await probe.fetchRepository({ owner: parsed.owner, repo: parsed.repo });
      if (!repoInfo || typeof repoInfo.githubRepositoryId !== 'string' || repoInfo.githubRepositoryId.trim().length === 0) {
        throw err.providerDown('无法确认仓库身份，收录已中止。');
      }
      // 归档仓库不许收录：归档意味着不再接受变更，收录后无法维护。
      if (repoInfo.isArchived) {
        throw err.unavailable('该仓库已归档，不接受新的插件收录。');
      }

      // 2) package.json 有 dsh.bundle 声明
      const manifest = await probe.fetchPluginManifest({
        owner: parsed.owner,
        repo: parsed.repo,
        pluginPath: parsed.pluginPath,
      });
      if (manifest === null) {
        throw err.input(
          '该目录下的 package.json 没有声明 dsh.bundle，无法作为 DSH 插件收录。',
          [{ path: 'url', message: `路径 ${parsed.pluginPath} 未声明 dsh.bundle。` }],
        );
      }
      const bundlePath = typeof manifest.bundlePath === 'string' ? manifest.bundlePath.trim() : '';
      if (bundlePath.length === 0) {
        throw err.input('dsh.bundle 声明为空，无法确定插件配置文件。', [
          { path: 'url', message: 'dsh.bundle 必须指向具体文件。' },
        ]);
      }
      // 3) 引用的配置文件存在
      if (manifest.bundleExists !== true) {
        throw err.input(`dsh.bundle 引用的配置文件不存在：${bundlePath}`, [
          { path: 'url', message: `未找到 ${bundlePath}。` },
        ]);
      }

      const now = Date.now();
      const pluginPath = parsed.pluginPath === ROOT_PLUGIN_PATH ? ROOT_PLUGIN_PATH : parsed.pluginPath;

      // ---- 入库（单事务）：仓库 upsert + 插件幂等 + 回执 ----
      return withTransaction(
        (tx) => {
          const existingRepo = tx.db
            .prepare('SELECT id FROM repositories WHERE github_repository_id = ?')
            .get(repoInfo.githubRepositoryId) as { id: string } | undefined;

          let repositoryId: string;
          if (existingRepo) {
            repositoryId = existingRepo.id;
            tx.db
              .prepare(
                `UPDATE repositories
                    SET full_name = ?, html_url = ?, is_archived = ?,
                        availability_state = 'available', last_checked_at = ?, last_successful_check_at = ?, updated_at = ?
                  WHERE id = ?`,
              )
              .run(
                repoInfo.fullName,
                repoInfo.htmlUrl,
                repoInfo.isArchived ? 1 : 0,
                now,
                now,
                now,
                repositoryId,
              );
          } else {
            repositoryId = newId(now);
            tx.db
              .prepare(
                `INSERT INTO repositories
                   (id, github_repository_id, full_name, html_url, is_archived, availability_state,
                    last_checked_at, last_successful_check_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?, ?)`,
              )
              .run(
                repositoryId,
                repoInfo.githubRepositoryId,
                repoInfo.fullName,
                repoInfo.htmlUrl,
                repoInfo.isArchived ? 1 : 0,
                now,
                now,
                now,
                now,
              );
          }

          // 幂等核心：先按 (repository_id, plugin_path) 查；命中即复用，
          // 只更新 updated_at（资料同步），绝不新建第二行。
          const existingPlugin = tx.db
            .prepare('SELECT id, created_at FROM plugins WHERE repository_id = ? AND plugin_path = ?')
            .get(repositoryId, pluginPath) as { id: string; created_at: number } | undefined;

          let pluginId: string;
          let created: boolean;
          if (existingPlugin) {
            pluginId = existingPlugin.id;
            created = false;
            tx.db.prepare('UPDATE plugins SET updated_at = ? WHERE id = ?').run(now, pluginId);
          } else {
            pluginId = newId(now);
            created = true;
            tx.db
              .prepare('INSERT INTO plugins (id, repository_id, plugin_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
              .run(pluginId, repositoryId, pluginPath, now, now);
          }

          // 回执：target_type 携带 repositoryId 以便重放还原；
          // changes 内保存请求摘要，用于区分同键同摘要与同键不同摘要。
          const already = tx.db
            .prepare('SELECT 1 AS x FROM operation_records WHERE action_type = ? AND operation_key = ?')
            .get(ACCEPT_PLUGIN_ACTION, input.requestKey) as { x: number } | undefined;
          if (!already) {
            tx.db
              .prepare(
                `INSERT INTO operation_records
                   (id, action_type, operation_key, actor_kind, actor_user_id, target_type, target_id,
                    target_snapshot, changes, reason, created_at)
                 VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                newId(now),
                ACCEPT_PLUGIN_ACTION,
                input.requestKey,
                ctx.userId,
                `plugin:${repositoryId}`,
                pluginId,
                JSON.stringify({ url: input.url, owner: parsed.owner, repo: parsed.repo, plugin_path: pluginPath }),
                JSON.stringify({ request_digest: requestDigest, created, bundle_path: bundlePath }),
                '用户提交插件收录。',
                now,
              );
          }

          return { pluginId, repositoryId, created, status: 'accepted' as const };
        },
        db,
      );
    },

    async getPlugin(pluginId: string): Promise<PluginView | null> {
      if (typeof pluginId !== 'string' || pluginId.length === 0) return null;
      return withRead((conn) => {
        const row = conn
          .prepare(
            `SELECT p.id AS plugin_id, p.plugin_path, p.created_at AS plugin_created_at, p.updated_at AS plugin_updated_at,
                    r.id AS repository_id, r.github_repository_id, r.full_name, r.html_url, r.is_archived,
                    r.availability_state, r.last_checked_at, r.last_successful_check_at
               FROM plugins p
               JOIN repositories r ON r.id = p.repository_id
              WHERE p.id = ?`,
          )
          .get(pluginId) as
          | {
              plugin_id: string;
              plugin_path: string;
              plugin_created_at: number;
              plugin_updated_at: number;
              repository_id: string;
              github_repository_id: string;
              full_name: string;
              html_url: string;
              is_archived: number;
              availability_state: 'unknown' | 'available' | 'unavailable';
              last_checked_at: number | null;
              last_successful_check_at: number | null;
            }
          | undefined;
        if (!row) return null;
        return {
          pluginId: row.plugin_id,
          pluginPath: row.plugin_path,
          createdAt: row.plugin_created_at,
          updatedAt: row.plugin_updated_at,
          repository: {
            repositoryId: row.repository_id,
            githubRepositoryId: row.github_repository_id,
            fullName: row.full_name,
            htmlUrl: row.html_url,
            isArchived: row.is_archived === 1,
            availabilityState: row.availability_state,
            lastCheckedAt: row.last_checked_at,
            lastSuccessfulCheckAt: row.last_successful_check_at,
          },
        };
      }, db);
    },

    async listPlugins(req: PageRequest): Promise<PageResult<PluginSummary>> {
      return withRead((conn) => {
        const total = conn.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number };
        // 分页纪律：固定排序键（updated_at DESC, id），否则翻页会重复/漏项。
        const rows = conn
          .prepare(
            `SELECT p.id AS plugin_id, p.plugin_path, p.updated_at,
                    r.full_name, r.html_url, r.is_archived
               FROM plugins p
               JOIN repositories r ON r.id = p.repository_id
              ORDER BY p.updated_at DESC, p.id ASC
              LIMIT ? OFFSET ?`,
          )
          .all(req.page_size, (req.page - 1) * req.page_size) as {
          plugin_id: string;
          plugin_path: string;
          updated_at: number;
          full_name: string;
          html_url: string;
          is_archived: number;
        }[];

        const items: PluginSummary[] = rows.map((r) => ({
          pluginId: r.plugin_id,
          pluginPath: r.plugin_path,
          repositoryFullName: r.full_name,
          repositoryHtmlUrl: r.html_url,
          isArchived: r.is_archived === 1,
          updatedAt: r.updated_at,
        }));

        return buildPage(items, total.c, req);
      }, db);
    },
  };
}
