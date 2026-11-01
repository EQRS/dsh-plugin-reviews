/**
 * 精选专栏（迁移 0033，设计见 docs/项目规划/设计-精选专栏.md）。
 *
 * 三条边界：
 *   1. 期号是身份：创建时取 MAX+1（同事务），URL 用期号，改标题不影响链接；
 *   2. 清单整份提交：换位与逐项文案必须原子落库，逐条 PATCH 会留下「顺序变了、文案没变」的中间态；
 *      并发用 state_version 乐观锁变成一次明确的 409；
 *   3. 收藏夹只读：编辑页从收藏夹挑插件，但这里不读也不写 favorite_folders。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { isAdmin, type CallerContext } from '@/server/platform/context';
import { recordOperationInTx } from '@/server/modules/operations';
import { deliverFeaturedPublishedNotification } from '@/server/modules/notifications';
import { buildPage, type PageResult } from '@/packages/common/result';

export const FEATURED_LIMITS = {
  titleMax: 80,
  themeMax: 200,
  prefaceMax: 20000,
  summaryMax: 200,
  reasonMax: 1000,
  detailUrlMax: 2000,
  maxItems: 40,
} as const;

export interface FeaturedItemInput {
  pluginId: string;
  summary: string;
  reason: string;
  /** 0-100 整数，编辑按插件功能性打分。 */
  score: number;
  detailUrl?: string | null;
  recommendedVersion?: string | null;
}

export interface FeaturedSummary {
  issueNumber: number;
  title: string;
  theme: string;
  publishedAt: number | null;
  updatedAt: number;
  itemCount: number;
  status: 'draft' | 'published';
}

export interface FeaturedItemView {
  itemId: string;
  pluginId: string;
  position: number;
  summary: string;
  reason: string;
  score: number;
  detailUrl: string | null;
  recommendedVersion: string | null;
  plugin: {
    displayName: string | null;
    pluginPath: string;
    repositoryFullName: string;
    htmlUrl: string;
    ownerAvatarUrl: string | null;
    isArchived: boolean;
    availabilityState: 'unknown' | 'available' | 'unavailable';
  };
}

export interface FeaturedDetail {
  issueNumber: number;
  title: string;
  theme: string;
  prefaceMarkdown: string;
  status: 'draft' | 'published';
  publishedAt: number | null;
  updatedAt: number;
  stateVersion: number;
  items: FeaturedItemView[];
}

interface ColumnRow {
  id: string;
  issue_number: number;
  title: string;
  theme: string;
  preface_md: string;
  status: 'draft' | 'published';
  published_at: number | null;
  state_version: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  plugin_id: string;
  position: number;
  summary: string;
  reason: string;
  score: number;
  detail_url: string | null;
  recommended_version: string | null;
  display_name: string | null;
  plugin_path: string;
  full_name: string;
  html_url: string;
  owner_avatar_url: string | null;
  is_archived: number;
  availability_state: 'unknown' | 'available' | 'unavailable';
}

const ITEM_SELECT =
  'SELECT i.id, i.plugin_id, i.position, i.summary, i.reason, i.score, i.detail_url, ' +
  'i.recommended_version, p.display_name, p.plugin_path, r.owner_avatar_url, ' +
  'r.full_name, r.html_url, r.is_archived, r.availability_state ' +
  'FROM featured_column_items i ' +
  'JOIN plugins p ON p.id = i.plugin_id ' +
  'JOIN repositories r ON r.id = p.repository_id';

function toItemView(row: ItemRow): FeaturedItemView {
  return {
    itemId: row.id,
    pluginId: row.plugin_id,
    position: Number(row.position),
    summary: row.summary,
    reason: row.reason,
    score: Number(row.score),
    detailUrl: row.detail_url,
    recommendedVersion: row.recommended_version,
    plugin: {
      displayName: row.display_name,
      pluginPath: row.plugin_path,
      repositoryFullName: row.full_name,
      htmlUrl: row.html_url,
      ownerAvatarUrl: row.owner_avatar_url,
      isArchived: row.is_archived === 1,
      availabilityState: row.availability_state,
    },
  };
}

function readColumnByIssue(db: SqliteDatabase, issueNumber: number): ColumnRow {
  const row = db
    .prepare(
      'SELECT id, issue_number, title, theme, preface_md, status, published_at, state_version, updated_at ' +
        'FROM featured_columns WHERE issue_number = ?',
    )
    .get(issueNumber) as ColumnRow | undefined;
  if (!row) throw err.unavailable('这一期精选不存在。');
  return row;
}

function readDetail(db: SqliteDatabase, column: ColumnRow): FeaturedDetail {
  const items = db
    .prepare(ITEM_SELECT + ' WHERE i.column_id = ? ORDER BY i.position ASC, i.id ASC')
    .all(column.id) as ItemRow[];
  return {
    issueNumber: Number(column.issue_number),
    title: column.title,
    theme: column.theme,
    prefaceMarkdown: column.preface_md,
    status: column.status,
    publishedAt: column.published_at,
    updatedAt: Number(column.updated_at),
    stateVersion: Number(column.state_version),
    items: items.map(toItemView),
  };
}

/** 校验并规范化一条条目输入。 */
function normalizeItem(
  db: SqliteDatabase,
  input: FeaturedItemInput,
  index: number,
): {
  pluginId: string;
  summary: string;
  reason: string;
  score: number;
  detailUrl: string | null;
  recommendedVersion: string | null;
} {
  const path = 'items[' + index + ']';
  if (typeof input.pluginId !== 'string' || input.pluginId.trim() === '') {
    throw err.input('缺少插件标识。', [{ path: path + '.pluginId', message: '必填' }]);
  }
  const plugin = db.prepare('SELECT id FROM plugins WHERE id = ?').get(input.pluginId) as
    | { id: string }
    | undefined;
  if (!plugin) {
    throw err.input('所选插件不存在。', [{ path: path + '.pluginId', message: '未知插件' }]);
  }

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length === 0 || summary.length > FEATURED_LIMITS.summaryMax) {
    throw err.input('插件简述需 1-' + FEATURED_LIMITS.summaryMax + ' 字。', [
      { path: path + '.summary', message: '必填且不超长' },
    ]);
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0 || reason.length > FEATURED_LIMITS.reasonMax) {
    throw err.input('推荐理由需 1-' + FEATURED_LIMITS.reasonMax + ' 字。', [
      { path: path + '.reason', message: '必填且不超长' },
    ]);
  }

  const score = input.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) {
    throw err.input('评分是 0-100 的整数。', [{ path: path + '.score', message: '0-100 整数' }]);
  }

  const rawUrl = typeof input.detailUrl === 'string' ? input.detailUrl.trim() : '';
  if (rawUrl.length > 0 && !/^https:\/\//i.test(rawUrl)) {
    throw err.input('链接必须是 https:// 开头。', [{ path: path + '.detailUrl', message: '只接受 https' }]);
  }
  if (rawUrl.length > FEATURED_LIMITS.detailUrlMax) {
    throw err.input('链接过长。', [{ path: path + '.detailUrl', message: '不超过 2000 字' }]);
  }

  const version = typeof input.recommendedVersion === 'string' ? input.recommendedVersion.trim() : '';

  return {
    pluginId: input.pluginId,
    summary,
    reason,
    score,
    detailUrl: rawUrl.length === 0 ? null : rawUrl,
    recommendedVersion: version.length === 0 ? null : version.slice(0, 40),
  };
}

function assertAdmin(ctx: CallerContext, message: string): string {
  if (!isAdmin(ctx) || !ctx.userId) throw err.forbidden(message);
  return ctx.userId;
}

export function createFeaturedService(deps: { db?: SqliteDatabase } = {}) {
  const db = deps.db ?? getDb();

  return {
    /** 读者侧：已发布各期（倒序分页）。 */
    async listPublished(req: { page?: number; pageSize?: number } = {}): Promise<PageResult<FeaturedSummary>> {
      const page = Math.max(1, Math.floor(req.page ?? 1));
      const pageSize = Math.min(50, Math.max(1, Math.floor(req.pageSize ?? 10)));
      return withRead((conn) => {
        const total = Number(
          (conn.prepare("SELECT COUNT(*) AS c FROM featured_columns WHERE status = 'published'").get() as {
            c: number;
          }).c,
        );
        const rows = conn
          .prepare(
            "SELECT c.issue_number, c.title, c.theme, c.published_at, c.updated_at, c.status, " +
              '(SELECT COUNT(*) FROM featured_column_items i WHERE i.column_id = c.id) AS item_count ' +
              "FROM featured_columns c WHERE c.status = 'published' " +
              'ORDER BY c.published_at DESC, c.issue_number DESC LIMIT ? OFFSET ?',
          )
          .all(pageSize, (page - 1) * pageSize) as Array<{
          issue_number: number;
          title: string;
          theme: string;
          published_at: number | null;
          updated_at: number;
          status: 'draft' | 'published';
          item_count: number;
        }>;
        return buildPage(
          rows.map((row) => ({
            issueNumber: Number(row.issue_number),
            title: row.title,
            theme: row.theme,
            publishedAt: row.published_at,
            updatedAt: Number(row.updated_at),
            itemCount: Number(row.item_count),
            status: row.status,
          })),
          total,
          { page, page_size: pageSize },
        );
      }, db);
    },

    /** 读者侧：单期（草稿对非管理员不可见）。 */
    async getPublished(ctx: CallerContext, issueNumber: number): Promise<FeaturedDetail> {
      return withRead((conn) => {
        const column = readColumnByIssue(conn, issueNumber);
        if (column.status !== 'published' && !isAdmin(ctx)) {
          throw err.unavailable('这一期精选还没有发布。');
        }
        return readDetail(conn, column);
      }, db);
    },

    /** 管理端：全部期（含草稿）。 */
    async listForAdmin(ctx: CallerContext): Promise<FeaturedSummary[]> {
      assertAdmin(ctx, '只有管理员可以管理精选专栏。');
      return withRead((conn) => {
        const rows = conn
          .prepare(
            'SELECT c.issue_number, c.title, c.theme, c.published_at, c.updated_at, c.status, ' +
              '(SELECT COUNT(*) FROM featured_column_items i WHERE i.column_id = c.id) AS item_count ' +
              'FROM featured_columns c ORDER BY c.issue_number DESC',
          )
          .all() as Array<{
          issue_number: number;
          title: string;
          theme: string;
          published_at: number | null;
          updated_at: number;
          status: 'draft' | 'published';
          item_count: number;
        }>;
        return rows.map((row) => ({
          issueNumber: Number(row.issue_number),
          title: row.title,
          theme: row.theme,
          publishedAt: row.published_at,
          updatedAt: Number(row.updated_at),
          itemCount: Number(row.item_count),
          status: row.status,
        }));
      }, db);
    },

    /** 管理端：编辑页数据。 */
    async getForEdit(ctx: CallerContext, issueNumber: number): Promise<FeaturedDetail> {
      assertAdmin(ctx, '只有管理员可以管理精选专栏。');
      return withRead((conn) => readDetail(conn, readColumnByIssue(conn, issueNumber)), db);
    },

    /** 新建草稿：期号取 MAX+1；同 requestKey 幂等。 */
    async createDraft(
      ctx: CallerContext,
      input: { title: string; theme: string; prefaceMd?: string; requestKey: string },
    ): Promise<{ issueNumber: number }> {
      const adminId = assertAdmin(ctx, '只有管理员可以创建精选专栏。');
      if (typeof input.requestKey !== 'string' || input.requestKey.trim() === '') {
        throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
      }

      const title = (input.title ?? '').trim();
      const theme = (input.theme ?? '').trim();
      const preface = input.prefaceMd ?? '';
      if (title.length === 0 || title.length > FEATURED_LIMITS.titleMax) {
        throw err.input('标题需 1-' + FEATURED_LIMITS.titleMax + ' 字。', [{ path: 'title', message: '必填' }]);
      }
      if (theme.length === 0 || theme.length > FEATURED_LIMITS.themeMax) {
        throw err.input('主题需 1-' + FEATURED_LIMITS.themeMax + ' 字。', [{ path: 'theme', message: '必填' }]);
      }
      if (preface.length > FEATURED_LIMITS.prefaceMax) {
        throw err.input('前言过长。', [{ path: 'prefaceMd', message: '不超过 20000 字' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const existing = conn
          .prepare('SELECT issue_number FROM featured_columns WHERE created_by = ? AND request_key = ?')
          .get(adminId, input.requestKey) as { issue_number: number } | undefined;
        if (existing) return { issueNumber: Number(existing.issue_number) };

        const now = nowMs();
        const nextIssue =
          Number(
            (conn.prepare('SELECT COALESCE(MAX(issue_number), 0) AS n FROM featured_columns').get() as { n: number })
              .n,
          ) + 1;
        conn
          .prepare(
            'INSERT INTO featured_columns ' +
              '(id, issue_number, title, theme, preface_md, status, published_at, created_by, request_key, ' +
              'state_version, created_at, updated_at) ' +
              "VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, 0, ?, ?)",
          )
          .run(newId(now), nextIssue, title, theme, preface, adminId, input.requestKey, now, now);

        recordOperationInTx(
          conn,
          {
            actionType: 'featured.create',
            operationKey: input.requestKey,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'featured_column',
            targetId: String(nextIssue),
            targetSnapshot: { title, theme },
            changes: { issue_number: nextIssue },
            reason: '管理员创建精选专栏草稿',
          },
          now,
        );

        return { issueNumber: nextIssue };
      }, db);
    },

    /**
     * 保存（元信息 + 整份清单）。
     *
     * 整份替换而不是逐条 diff：顺序与文案必须原子落库；条目数上限很小（<=40），
     * 全删全插最简单，也不会留下半套状态。
     */
    async saveDraft(
      ctx: CallerContext,
      issueNumber: number,
      input: {
        title: string;
        theme: string;
        prefaceMd: string;
        items: FeaturedItemInput[];
        expectedVersion: number;
      },
    ): Promise<{ issueNumber: number; stateVersion: number }> {
      const adminId = assertAdmin(ctx, '只有管理员可以编辑精选专栏。');
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw err.input('缺少预期版本。', [{ path: 'expectedVersion', message: '非负整数' }]);
      }
      if (!Array.isArray(input.items)) {
        throw err.input('缺少插件清单。', [{ path: 'items', message: '必填' }]);
      }
      if (input.items.length > FEATURED_LIMITS.maxItems) {
        throw err.input('一期最多 ' + FEATURED_LIMITS.maxItems + ' 个插件。', [
          { path: 'items', message: '超过上限' },
        ]);
      }

      const title = (input.title ?? '').trim();
      const theme = (input.theme ?? '').trim();
      if (title.length === 0 || title.length > FEATURED_LIMITS.titleMax) {
        throw err.input('标题需 1-' + FEATURED_LIMITS.titleMax + ' 字。', [{ path: 'title', message: '必填' }]);
      }
      if (theme.length === 0 || theme.length > FEATURED_LIMITS.themeMax) {
        throw err.input('主题需 1-' + FEATURED_LIMITS.themeMax + ' 字。', [{ path: 'theme', message: '必填' }]);
      }
      if (input.prefaceMd.length > FEATURED_LIMITS.prefaceMax) {
        throw err.input('前言过长。', [{ path: 'prefaceMd', message: '不超过 20000 字' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const column = readColumnByIssue(conn, issueNumber);
        if (column.state_version !== input.expectedVersion) {
          throw err.conflict('这一期已被其他窗口修改，请刷新后重试。', {
            current_version: column.state_version,
            expected_version: input.expectedVersion,
          });
        }

        const seen = new Set<string>();
        const normalized = input.items.map((item, index) => {
          const next = normalizeItem(conn, item, index);
          if (seen.has(next.pluginId)) {
            throw err.input('同一个插件不能重复加入同一期。', [
              { path: 'items[' + index + '].pluginId', message: '重复' },
            ]);
          }
          seen.add(next.pluginId);
          return next;
        });

        const now = nowMs();
        conn.prepare('DELETE FROM featured_column_items WHERE column_id = ?').run(column.id);
        normalized.forEach((item, index) => {
          conn
            .prepare(
              'INSERT INTO featured_column_items ' +
                '(id, column_id, plugin_id, position, summary, reason, score, detail_url, recommended_version, ' +
                'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              newId(now),
              column.id,
              item.pluginId,
              index,
              item.summary,
              item.reason,
              item.score,
              item.detailUrl,
              item.recommendedVersion,
              now,
              now,
            );
        });

        const nextVersion = column.state_version + 1;
        conn
          .prepare(
            'UPDATE featured_columns SET title = ?, theme = ?, preface_md = ?, state_version = ?, updated_at = ? ' +
              'WHERE id = ? AND state_version = ?',
          )
          .run(title, theme, input.prefaceMd, nextVersion, now, column.id, input.expectedVersion);

        recordOperationInTx(
          conn,
          {
            actionType: 'featured.update',
            operationKey: 'featured_update:' + issueNumber + ':' + newId(now),
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'featured_column',
            targetId: String(issueNumber),
            targetSnapshot: { title, theme, items: normalized.length },
            changes: { state_version: nextVersion },
            reason: '管理员编辑精选专栏',
          },
          now,
        );

        return { issueNumber, stateVersion: nextVersion };
      }, db);
    },

    /** 发布：校验必填，置 published_at。 */
    async publish(
      ctx: CallerContext,
      issueNumber: number,
      input: { expectedVersion: number },
    ): Promise<{ issueNumber: number; publishedAt: number; notified: number }> {
      const adminId = assertAdmin(ctx, '只有管理员可以发布精选专栏。');
      return withTransaction((tx) => {
        const conn = tx.db;
        const column = readColumnByIssue(conn, issueNumber);
        if (column.status === 'published') {
          throw err.conflict('这一期已经发布过了。', { issueNumber });
        }
        if (column.state_version !== input.expectedVersion) {
          throw err.conflict('这一期已被其他窗口修改，请刷新后重试。', {
            current_version: column.state_version,
            expected_version: input.expectedVersion,
          });
        }

        const itemCount = Number(
          (conn.prepare('SELECT COUNT(*) AS c FROM featured_column_items WHERE column_id = ?').get(column.id) as {
            c: number;
          }).c,
        );
        if (column.preface_md.trim().length === 0) {
          throw err.input('发布前需要填写前言。', [{ path: 'prefaceMd', message: '必填' }]);
        }
        if (itemCount === 0) {
          throw err.input('发布前至少要有 1 个插件。', [{ path: 'items', message: '至少 1 个' }]);
        }

        const now = nowMs();
        conn
          .prepare(
            "UPDATE featured_columns SET status = 'published', published_at = ?, " +
              "state_version = state_version + 1, updated_at = ? WHERE id = ? AND status = 'draft' AND state_version = ?",
          )
          .run(now, now, column.id, input.expectedVersion);

        recordOperationInTx(
          conn,
          {
            actionType: 'featured.publish',
            operationKey: 'featured_publish:' + issueNumber,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'featured_column',
            targetId: String(issueNumber),
            targetSnapshot: { title: column.title, items: itemCount },
            changes: { status: 'published' },
            reason: '管理员发布精选专栏',
          },
          now,
        );

        // 发布即通知订阅者（同一事务：要么都成立，要么都不成立）
        const notified = notifyFeaturedSubscribers(conn, {
          issueNumber,
          title: column.title,
          theme: column.theme,
        });

        return { issueNumber, publishedAt: now, notified: notified.delivered };
      }, db);
    },

    /** 删除草稿（已发布不可删：历史链接要能打开）。 */
    async deleteDraft(ctx: CallerContext, issueNumber: number): Promise<{ deleted: boolean }> {
      const adminId = assertAdmin(ctx, '只有管理员可以删除精选专栏。');
      return withTransaction((tx) => {
        const conn = tx.db;
        const column = readColumnByIssue(conn, issueNumber);
        if (column.status === 'published') {
          throw err.conflict('已发布的期不提供删除（历史链接要能打开）。', { issueNumber });
        }
        conn.prepare('DELETE FROM featured_columns WHERE id = ?').run(column.id);
        recordOperationInTx(
          conn,
          {
            actionType: 'featured.delete',
            operationKey: 'featured_delete:' + issueNumber,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'featured_column',
            targetId: String(issueNumber),
            targetSnapshot: { title: column.title },
            changes: { deleted: true },
            reason: '管理员删除精选专栏草稿',
          },
          nowMs(),
        );
        return { deleted: true };
      }, db);
    },
  };
}

export type FeaturedService = ReturnType<typeof createFeaturedService>;

/**
 * 「精选」标签：这些插件被多少期已发布的专栏推荐过。
 *
 * 一条 IN 查询批量取，避免插件列表逐行 N+1；没入选的插件不出现在 Map 里。
 */
export function featuredCountsForPlugins(db: SqliteDatabase, pluginIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  const ids = [...new Set(pluginIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      'SELECT i.plugin_id, COUNT(*) AS c FROM featured_column_items i ' +
        "JOIN featured_columns c ON c.id = i.column_id WHERE c.status = 'published' " +
        'AND i.plugin_id IN (' +
        placeholders +
        ') GROUP BY i.plugin_id',
    )
    .all(...ids) as Array<{ plugin_id: string; c: number }>;
  for (const row of rows) result.set(row.plugin_id, Number(row.c));
  return result;
}

/**
 * 精选订阅（订阅栏目，不是单期）+ 发布时投递。
 *
 * 与「收藏」的区别：收藏是把具体内容收进自己的夹子；订阅是把**栏目的未来更新**通知给我。
 * 所以每人一行、没有可订阅的"对象选择"——只有订阅/取消两种状态。
 */

/** 系统账号：订阅通知没有真人触发者（与整合包自动分支同一个固定 id）。 */
const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000000';

function ensureSystemActor(db: SqliteDatabase): void {
  // 与 packs 的 ensureSystemUser 同义：不写进迁移，避免污染「用户总数」等既有口径。
  db.prepare(
    `INSERT INTO users (id, nickname, avatar_url, role, account_status, created_at, updated_at)
     VALUES (?, '系统', NULL, 'user', 'active', 0, 0)
     ON CONFLICT (id) DO NOTHING`,
  ).run(SYSTEM_ACTOR_ID);
}

export interface SubscriptionState {
  subscribed: boolean;
  /** 订阅人数（只给管理员看；普通读者只看自己的状态）。 */
  subscriberCount?: number;
}

/**
 * 通知所有订阅者：新一期发布。
 *
 * 在发布事务里调用 —— 发布与通知同生共死，不会出现「期发布了但没人收到」。
 * 收件人里跳过系统账号自己（数据库 CHECK 也兜底 recipient <> actor）。
 */
export function notifyFeaturedSubscribers(
  conn: SqliteDatabase,
  input: { issueNumber: number; title: string; theme: string },
): { delivered: number } {
  const subscribers = conn.prepare('SELECT user_id FROM featured_subscriptions').all() as Array<{
    user_id: string;
  }>;
  if (subscribers.length === 0) return { delivered: 0 };

  ensureSystemActor(conn);
  const now = nowMs();
  const detail =
    '精选更新：第 ' + input.issueNumber + ' 期「' + input.title + '」已发布。主题：' + input.theme;
  const linkUrl = '/featured/' + input.issueNumber;

  let delivered = 0;
  for (const row of subscribers) {
    const result = deliverFeaturedPublishedNotification(conn, {
      recipientId: row.user_id,
      actorId: SYSTEM_ACTOR_ID,
      detail,
      linkUrl,
      deduplicationKey: 'featured:' + input.issueNumber + ':' + row.user_id,
      now,
    });
    if (result.created) delivered += 1;
  }
  return { delivered };
}

export function createFeaturedSubscriptionService(deps: { db: SqliteDatabase }) {
  const db = deps.db;

  return {
    async getState(ctx: CallerContext, options: { withCount?: boolean } = {}): Promise<SubscriptionState> {
      if (ctx.userId === null) {
        if (!options.withCount) return { subscribed: false };
        const count = Number(
          (db.prepare('SELECT COUNT(*) AS c FROM featured_subscriptions').get() as { c: number }).c,
        );
        return { subscribed: false, subscriberCount: count };
      }
      return withRead((conn) => {
        const row = conn
          .prepare('SELECT 1 AS ok FROM featured_subscriptions WHERE user_id = ?')
          .get(ctx.userId) as { ok: number } | undefined;
        if (!options.withCount) return { subscribed: row !== undefined };
        const count = Number(
          (conn.prepare('SELECT COUNT(*) AS c FROM featured_subscriptions').get() as { c: number }).c,
        );
        return { subscribed: row !== undefined, subscriberCount: count };
      }, db);
    },

    /** 订阅（幂等：重复订阅不报错、也不重置订阅时间）。 */
    async subscribe(ctx: CallerContext): Promise<{ subscribed: true }> {
      if (ctx.userId === null) throw err.unauthenticated();
      if (ctx.accountStatus !== 'active') throw err.disabled();
      return withTransaction((tx) => {
        tx.db
          .prepare('INSERT INTO featured_subscriptions (user_id, created_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING')
          .run(ctx.userId as string, nowMs());
        return { subscribed: true as const };
      }, db);
    },

    async unsubscribe(ctx: CallerContext): Promise<{ subscribed: false }> {
      if (ctx.userId === null) throw err.unauthenticated();
      return withTransaction((tx) => {
        tx.db.prepare('DELETE FROM featured_subscriptions WHERE user_id = ?').run(ctx.userId as string);
        return { subscribed: false as const };
      }, db);
    },

    notifySubscribers(conn: SqliteDatabase, input: { issueNumber: number; title: string; theme: string }) {
      return notifyFeaturedSubscribers(conn, input);
    },
  };
}

export type FeaturedSubscriptionService = ReturnType<typeof createFeaturedSubscriptionService>;
