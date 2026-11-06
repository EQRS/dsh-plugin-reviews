/**
 * 用户身份体系 · 插件归属（认领）。
 *
 * 这个模块只回答一个问题：「这个插件是不是这个人的」。
 *
 * 为什么需要它：`plugins` 表没有作者字段（只有 repository_id + plugin_path），
 * 而「开发者」身份的门槛是「至少一个本人的插件」。没有归属关系，这条门槛无法判定。
 *
 * 两条判定路径（设计文档 §3.3）：
 *   * **github_match**：用户的 external_identities.provider_username 与
 *     repositories.owner_login 相同（忽略大小写）。GitHub 账号已经过 OAuth 绑定，
 *     这条证据链足够强，**自动置 verified**，不再让人审核一遍。
 *   * **claimed**：仓库 owner 是组织（如 dsh-org/x）或用户是协作者而非 owner，
 *     自动匹配永远失败（站内没有哪个账号叫 dsh-org），只能主动声明 + 人工核实。
 *
 * 一个插件只能有一个 verified 归属人（库里有部分唯一索引兜底）。否则「我的插件」
 * 会出现两个人，开发者身份的门槛就说不清了。pending 与 rejected 不限——多人同时
 * 认领同一插件是合法情形，由管理员裁定。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { deliverPluginClaimResultNotification } from '@/server/modules/notifications';

export type OwnershipStatus = 'pending' | 'verified' | 'rejected';
export type OwnershipSource = 'github_match' | 'claimed';

/** 「我的插件」里的一行。 */
export interface MyPluginView {
  /** 归属记录 id（认领/审核按它定位；pluginId 是插件本身，两者不同）。 */
  ownershipId: string;
  pluginId: string;
  pluginPath: string;
  repositoryFullName: string;
  repositoryHtmlUrl: string;
  /** 展示名：插件清单里的名字优先，缺则回退仓库全名。 */
  displayName: string | null;
  ownerLogin: string | null;
  isArchived: boolean;
  ownershipStatus: OwnershipStatus;
  ownershipSource: OwnershipSource;
  /** 认领被驳回时的理由（管理员填的），verified / pending 时为 null。 */
  reviewNote: string | null;
  createdAt: number;
}

/** 后台认领队列里的一行：多带认领人与申请人自述。 */
export interface OwnershipQueueItem extends MyPluginView {
  userId: string;
  userNickname: string;
  claimedNote: string | null;
}

interface OwnershipRow {
  id: string;
  plugin_id: string;
  user_id: string;
  source: OwnershipSource;
  status: OwnershipStatus;
  claimed_note: string | null;
  reviewer_id: string | null;
  reviewed_at: number | null;
  created_at: number;
  plugin_path: string;
  repository_full_name: string;
  repository_html_url: string;
  owner_login: string | null;
  is_archived: number;
  display_name: string | null;
  user_nickname: string;
}

/** 「我的插件」查询：一次 JOIN 取齐展示需要的字段，避免 N+1。 */
const MY_PLUGIN_SELECT = `
  SELECT o.id, o.plugin_id, o.user_id, o.source, o.status, o.claimed_note,
         o.reviewer_id, o.reviewed_at, o.created_at,
         p.plugin_path, r.full_name AS repository_full_name, r.html_url AS repository_html_url,
         r.owner_login, r.is_archived,
         p.display_name, u.nickname AS user_nickname
    FROM plugin_ownerships o
    JOIN plugins p ON p.id = o.plugin_id
    JOIN repositories r ON r.id = p.repository_id
    JOIN users u ON u.id = o.user_id
`;

function toView(row: OwnershipRow): MyPluginView {
  return {
    ownershipId: row.id,
    pluginId: row.plugin_id,
    pluginPath: row.plugin_path,
    repositoryFullName: row.repository_full_name,
    repositoryHtmlUrl: row.repository_html_url,
    displayName: row.display_name ?? null,
    ownerLogin: row.owner_login,
    isArchived: row.is_archived === 1,
    ownershipStatus: row.status,
    ownershipSource: row.source,
    // 驳回理由只在 rejected 时有意义；其它状态一并给 null，避免页面误显示上次的旧理由
    reviewNote: row.status === 'rejected' ? row.claimed_note : null,
    createdAt: row.created_at,
  };
}

/**
 * 该用户与这个插件所属仓库的 owner 是否同一个 GitHub 账号。
 *
 * 忽略大小写：GitHub 的 username 不区分大小写（EQRS 与 eqrs 是同一个账号），
 * 严格比较会让一半的用户匹配不上。
 */
function isGithubOwnerMatch(conn: SqliteDatabase, userId: string, repositoryId: string): boolean {
  const row = conn
    .prepare(
      `SELECT 1 AS x
         FROM external_identities ei
         JOIN repositories r ON r.id = ?
        WHERE ei.user_id = ?
          AND ei.provider = 'github'
          AND lower(ei.provider_username) = lower(r.owner_login)`,
    )
    .get(repositoryId, userId);
  return row !== undefined;
}

export interface PluginOwnershipService {
  /** 我的插件：已归属的 + 待审的 + 被驳回的（被驳回的要能看到理由并重试）。 */
  listMine(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<MyPluginView[]>;

  /**
   * 认领一个插件。
   *
   * owner 匹配 → 直接 verified；否则落 pending 等审核。
   * 已经有记录时：rejected 可重新提交（复用同一行），pending/verified 直接拒绝。
   */
  claimPlugin(
    ctx: CallerContext,
    pluginId: string,
    input: { note?: string },
    injectedDb?: SqliteDatabase,
  ): Promise<{ status: OwnershipStatus; autoVerified: boolean }>;

  /** 后台：认领审核队列。status 缺省只看 pending。 */
  listQueue(
    ctx: CallerContext,
    status: OwnershipStatus | 'all',
    injectedDb?: SqliteDatabase,
  ): Promise<OwnershipQueueItem[]>;

  /** 后台：通过 / 驳回一次认领。 */
  reviewClaim(
    ctx: CallerContext,
    ownershipId: string,
    decision: 'verify' | 'reject',
    note: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<void>;

  /** 该用户已验证归属的插件数（开发者身份的资格判定用）。 */
  countVerifiedForUser(userId: string, injectedDb?: SqliteDatabase): Promise<number>;
}

/**
 * 认领结果通知（设计 §7）。
 *
 * 在审核事务内投递：投递函数返回 DeliverResult、不抛业务错，
 * 所以通知发不出去不会回滚审核结论（审核结论比通知重要）。
 * 去重键带结果，同一结论重放只发一条。
 */
function deliverClaimResult(
  conn: SqliteDatabase,
  input: {
    ownershipId: string;
    recipientId: string;
    adminId: string;
    approved: boolean;
    note: string | null;
    now: number;
  },
): void {
  deliverPluginClaimResultNotification(conn, {
    recipientId: input.recipientId,
    actorId: input.adminId,
    detail: input.approved
      ? '你认领的插件已通过审核，可以在「我的插件」里看到。'
      : `你认领的插件未通过审核${input.note ? `：${input.note}` : '。'}`,
    linkUrl: '/me/my-plugins',
    deduplicationKey: `plugin_claim:${input.ownershipId}:${input.recipientId}:${input.approved ? 'approved' : 'rejected'}`,
    now: input.now,
  });
}

export function createPluginOwnershipService(deps: { db: SqliteDatabase }): PluginOwnershipService {
  const db = deps.db;

  return {
    async listMine(ctx, injectedDb) {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const rows = conn
          .prepare(`${MY_PLUGIN_SELECT} WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id`)
          .all(userId) as OwnershipRow[];
        return rows.map(toView);
      }, injectedDb ?? db);
    },

    async claimPlugin(ctx, pluginId, input, injectedDb) {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const note = (input.note ?? '').trim();
      if (note.length > 500) {
        throw err.input('认领说明最多 500 字。', [{ path: 'note', message: '超长' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const plugin = conn
          .prepare('SELECT id, repository_id FROM plugins WHERE id = ?')
          .get(pluginId) as { id: string; repository_id: string } | undefined;
        if (!plugin) throw err.unavailable('插件不存在。');

        const matched = isGithubOwnerMatch(conn, userId, plugin.repository_id);
        const existing = conn
          .prepare('SELECT id, status, source FROM plugin_ownerships WHERE plugin_id = ? AND user_id = ?')
          .get(pluginId, userId) as { id: string; status: OwnershipStatus; source: OwnershipSource } | undefined;

        const now = nowMs();

        if (existing) {
          if (existing.status === 'verified') {
            throw err.conflict('这个插件已经在你名下。');
          }
          if (existing.status === 'pending') {
            throw err.conflict('认领正在审核中，请等待管理员处理。');
          }
          // rejected：复用同一行重新提交。owner 匹配的话这次直接通过。
          conn
            .prepare(
              `UPDATE plugin_ownerships
                  SET source = ?, status = ?, claimed_note = ?, reviewer_id = NULL,
                      reviewed_at = NULL, created_at = ?
                WHERE id = ?`,
            )
            .run(
              matched ? 'github_match' : 'claimed',
              matched ? 'verified' : 'pending',
              note.length > 0 ? note : null,
              now,
              existing.id,
            );
          return { status: (matched ? 'verified' : 'pending') as OwnershipStatus, autoVerified: matched };
        }

        // 有人在别人名下验证过了：不阻止发起认领（pending 允许并存），但直接 verified 会撞唯一索引，
        // 这里提前给人话，而不是把约束错误抛出去。
        if (matched) {
          const taken = conn
            .prepare("SELECT 1 AS x FROM plugin_ownerships WHERE plugin_id = ? AND status = 'verified'")
            .get(pluginId);
          if (taken) throw err.conflict('这个插件已经归属其他用户，不能自动认领。如有异议请联系管理员。');
        }

        conn
          .prepare(
            `INSERT INTO plugin_ownerships
               (id, plugin_id, user_id, source, status, claimed_note, reviewer_id, reviewed_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            newId(now),
            pluginId,
            userId,
            matched ? 'github_match' : 'claimed',
            matched ? 'verified' : 'pending',
            note.length > 0 ? note : null,
            now,
          );
        return { status: (matched ? 'verified' : 'pending') as OwnershipStatus, autoVerified: matched };
      }, injectedDb ?? db);
    },

    async listQueue(ctx, status, injectedDb) {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以查看认领队列。');
      return withRead((conn) => {
        const where = status === 'all' ? '' : ' WHERE o.status = ?';
        const args = status === 'all' ? [] : [status];
        const rows = conn
          .prepare(`${MY_PLUGIN_SELECT}${where} ORDER BY o.created_at ASC, o.id`)
          .all(...args) as OwnershipRow[];
        return rows.map((row) => ({
          ...toView(row),
          userId: row.user_id,
          userNickname: row.user_nickname,
          claimedNote: row.claimed_note,
        }));
      }, injectedDb ?? db);
    },

    async reviewClaim(ctx, ownershipId, decision, note, injectedDb) {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核认领。');
      const adminId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const row = conn
          .prepare('SELECT id, user_id, status, source, plugin_id FROM plugin_ownerships WHERE id = ?')
          .get(ownershipId) as
          | { id: string; user_id: string; status: OwnershipStatus; source: OwnershipSource; plugin_id: string }
          | undefined;
        if (!row) throw err.unavailable('认领记录不存在。');
        if (row.status !== 'pending') throw err.conflict('这条认领已经处理过了。');

        const now = nowMs();
        if (decision === 'verify') {
          // 唯一索引会拦住「第二个 verified」；先查一遍是为了给一句人话
          const taken = conn
            .prepare("SELECT 1 AS x FROM plugin_ownerships WHERE plugin_id = ? AND status = 'verified'")
            .get(row.plugin_id);
          if (taken) throw err.conflict('这个插件已经有归属人了，请先处理那一条。');
          conn
            .prepare(
              "UPDATE plugin_ownerships SET status = 'verified', reviewer_id = ?, reviewed_at = ? WHERE id = ?",
            )
            .run(adminId, now, ownershipId);
          deliverClaimResult(conn, {
            ownershipId,
            recipientId: row.user_id,
            adminId: adminId as string,
            approved: true,
            note: null,
            now,
          });
          return;
        }

        conn
          .prepare(
            `UPDATE plugin_ownerships
                SET status = 'rejected', reviewer_id = ?, reviewed_at = ?, claimed_note = ?
              WHERE id = ?`,
          )
          .run(adminId, now, note !== null && note.trim().length > 0 ? note.trim().slice(0, 500) : null, ownershipId);
        deliverClaimResult(conn, {
          ownershipId,
          recipientId: row.user_id,
          adminId: adminId as string,
          approved: false,
          note: note !== null && note.trim().length > 0 ? note.trim().slice(0, 500) : null,
          now,
        });
      }, injectedDb ?? db);
    },

    async countVerifiedForUser(userId, injectedDb) {
      return withRead((conn) => {
        const row = conn
          .prepare("SELECT COUNT(*) AS c FROM plugin_ownerships WHERE user_id = ? AND status = 'verified'")
          .get(userId) as { c: number };
        return Number(row.c);
      }, injectedDb ?? db);
    },
  };
}

/** 进程级单例（与其它模块一致）。 */
let singleton: PluginOwnershipService | null = null;
export function pluginOwnershipService(): PluginOwnershipService {
  if (!singleton) singleton = createPluginOwnershipService({ db: getDb() });
  return singleton;
}
export function resetPluginOwnershipService(): void {
  singleton = null;
}
