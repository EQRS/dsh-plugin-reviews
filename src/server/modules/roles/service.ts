/**
 * 用户身份体系 · 身份服务（测评员 / 开发者）。
 *
 * 设计：docs/项目规划/设计-用户身份体系.md §3.1 / §3.2 / §4 / §6
 * 迁移：migrations/0040_user_roles.sql
 *
 * 这个模块回答三件事：
 *   1. 「他凭什么申请」——资格判定（§4），申请那一刻把结果快照进 role_applications.evidence；
 *   2. 「他现在是什么身份」——user_roles 的实时读取，叠加在 users.role 之上，**不改底座**；
 *   3. 「申请走到哪一步了」——pending / approved / rejected / withdrawn 的状态机，含冷却期。
 *
 * 三条必须守住的边界：
 *   * **身份不是权限底座**：users.role（user/admin）仍然决定能否进后台、能否审内容；
 *     user_roles 只是能力标记，isAdmin() 的行为一个字都不变。
 *   * **撤销只打标记**（§11）：不动该用户的评测与插件。使用者明确裁定「撤销后的处置」
 *     暂未设计，所以这里不去猜它该连带下线什么。
 *   * **区长/协管不进 user_roles**（§3.4）：forum_board_moderators 是分区内角色，
 *     同一个人可能在 A 区是区长、B 区是普通用户。这里只做**只读汇总展示**。
 *
 * 资格快照为什么落库而不是审核时现算：用户申请后又删了一篇评测的话，现算会让管理员
 * 看到与申请人不同的数字，容易起争议；快照也让「凭什么批的」有据可查（§3.2）。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { DAY, nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { numberSetting } from '@/server/modules/settings';
import { createPluginOwnershipService } from './ownership';
import { deliverRoleApplicationResultNotification } from '@/server/modules/notifications';

// ============================================================
// 类型
// ============================================================

/** 可申请的身份。与迁移 0040 的 CHECK 取值逐字一致。 */
export const ROLE_TYPES = ['reviewer', 'developer'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

export type RoleStatus = 'active' | 'revoked';
export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** 身份申请自述的最大长度：与 role_applications.note 的 CHECK 对齐，先给人话。 */
const NOTE_MAX = 500;

/** 设置项键名（设计 §6）。冷却天数默认 30，管理员可调。 */
export const COOLDOWN_DAYS_KEY = 'roles.application_cooldown_days';
export const COOLDOWN_DAYS_DEFAULT = 30;

/** 「我的身份」里的一行。 */
export interface MyRoleView {
  roleType: RoleType;
  status: RoleStatus;
  /** 授予时刻（毫秒）；撤销后仍然保留，便于展示「曾于何时获得」。 */
  grantedAt: number;
  grantedBy: string | null;
  /** 授予自哪次申请；管理员直接授予时为空（当前无此通道，留字段）。 */
  applicationId: string | null;
  revokedAt: number | null;
}

/** 个人中心的「讨论区区长」汇总项（只读展示，不进 user_roles，设计 §3.4）。 */
export interface BoardModeratorSummary {
  boardId: string;
  boardSlug: string | null;
  boardName: string;
  role: string;
}

/** 资格判定结果：够不够 + 当前数字 + 缺什么（页面置灰按钮用，§5.1）。 */
export interface EligibilityResult {
  roleType: RoleType;
  eligible: boolean;
  /** 已发布的测评篇数（reviewer）或已验证归属的插件数（developer）。 */
  count: number;
  /** 资格不足时的说明；合格时为 null。 */
  reason: string | null;
  /** 申请时会原样写进 role_applications.evidence 的快照。 */
  evidence: Record<string, number>;
}

export interface ApplicationView {
  id: string;
  userId: string;
  roleType: RoleType;
  status: ApplicationStatus;
  /** 申请时的资格快照（原样解析；脏数据给 null，不让一条坏行炸掉整个列表）。 */
  evidence: Record<string, unknown> | null;
  note: string | null;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

/** 后台队列里的一行：多带申请人昵称。 */
export interface ApplicationQueueItem extends ApplicationView {
  userNickname: string;
}

/** 每个可申请身份的当前处境（页面按它决定按钮可点与否）。 */
export interface RoleApplicationSummary {
  roleType: RoleType;
  eligible: boolean;
  count: number;
  reason: string | null;
  /** 已持有该身份（active）。 */
  held: boolean;
  /** 当前 pending 申请 id（没有则 null）。 */
  pendingApplicationId: string | null;
  /** 冷却期截止时刻（毫秒）；不在冷却期为 null。 */
  cooldownUntil: number | null;
  /** 最近一次被驳回的申请 id（给「驳回理由」用）。 */
  lastRejectedApplicationId: string | null;
}

/** 「我的身份」整页数据。 */
export interface MyRolesView {
  userId: string;
  /** users.role 的底座角色，原样带出（身份叠加不改变它）。 */
  baseRole: 'user' | 'admin';
  roles: MyRoleView[];
  /** 分区区长/协管汇总：只读展示，权限判定仍按分区走。 */
  boardModerators: BoardModeratorSummary[];
  /** 每个可申请身份：资格、是否已持有、是否有待审申请、冷却期。 */
  applications: RoleApplicationSummary[];
  /** 我的全部申请记录（各状态都给，页面自行分组）。 */
  history: ApplicationView[];
}

// ============================================================
// 服务接口
// ============================================================

export interface RoleService {
  // ---- 资格（设计 §4）：只看内容与插件归属，不看 user_roles ----
  checkReviewerEligibility(userId: string, injectedDb?: SqliteDatabase): Promise<EligibilityResult>;
  checkDeveloperEligibility(userId: string, injectedDb?: SqliteDatabase): Promise<EligibilityResult>;
  /** 按身份分派到上面两个。 */
  checkEligibility(roleType: RoleType, userId: string, injectedDb?: SqliteDatabase): Promise<EligibilityResult>;

  // ---- 读 ----
  listMyRoles(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<MyRolesView>;
  /** 该用户当前所有 active 身份（供权限点直接使用）。 */
  listActiveRoles(userId: string, injectedDb?: SqliteDatabase): Promise<RoleType[]>;
  /** 便捷判定：当前调用者是否持有某身份（匿名 / 账户禁用 / 未持有都为 false）。 */
  hasRole(ctx: CallerContext, roleType: RoleType, injectedDb?: SqliteDatabase): Promise<boolean>;
  /** 该用户的底座角色（只读 users.role，绝不读 user_roles）。用户不存在为 null。 */
  isBaseAdmin(userId: string, injectedDb?: SqliteDatabase): 'user' | 'admin' | null;

  // ---- 申请人操作 ----
  applyForRole(
    ctx: CallerContext,
    roleType: RoleType,
    note?: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<ApplicationView>;
  withdrawApplication(ctx: CallerContext, applicationId: string, injectedDb?: SqliteDatabase): Promise<ApplicationView>;

  // ---- 管理员操作 ----
  listApplicationsForAdmin(
    ctx: CallerContext,
    status: ApplicationStatus | 'all',
    injectedDb?: SqliteDatabase,
  ): Promise<ApplicationQueueItem[]>;
  reviewApplication(
    ctx: CallerContext,
    applicationId: string,
    decision: 'approve' | 'reject',
    note?: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<ApplicationView>;
  /**
   * 撤销身份（设计 §11）：**只打撤销标记，不动内容**。
   *
   * note 目前无处落库（user_roles 没有理由列），保留参数是为了接口签名稳定；
   * 等设计给出「撤销后处置」再决定写哪儿。
   */
  revokeRole(
    ctx: CallerContext,
    userId: string,
    roleType: RoleType,
    note?: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<MyRoleView>;
}

// ============================================================
// 内部工具
// ============================================================

export interface RoleService {
  // ---- 资格（设计 §4）；userRole 表不参与，纯看内容与归属 ----
  checkReviewerEligibility(userId: string, injectedDb?: SqliteDatabase): Promise<EligibilityResult>;
  checkDeveloperEligibility(userId: string, injectedDb?: SqliteDatabase): Promise<EligibilityResult>;
  /** 按身份分派到上面两个。 */
  checkEligibility(roleType: RoleType, userId: string, injectedDb?: SqliteDatabase): Promise<EligibilityResult>;

  // ---- 读 ----
  listMyRoles(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<MyRolesView>;
  /** 该用户当前所有 active 身份（供权限点直接使用）。 */
  listActiveRoles(userId: string, injectedDb?: SqliteDatabase): Promise<RoleType[]>;
  /** 便捷判定：当前调用者是否持有某身份（匿名 / 账户禁用 / 未持有都为 false）。 */
  hasRole(ctx: CallerContext, roleType: RoleType, injectedDb?: SqliteDatabase): Promise<boolean>;
  /** 该用户的底座角色是否管理员（只读 users.role，绝不读 user_roles）。 */
  isBaseAdmin(userId: string, injectedDb?: SqliteDatabase): 'user' | 'admin' | null;

  // ---- 申请人操作 ----
  applyForRole(
    ctx: CallerContext,
    roleType: RoleType,
    note?: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<ApplicationView>;
  withdrawApplication(ctx: CallerContext, applicationId: string, injectedDb?: SqliteDatabase): Promise<ApplicationView>;

  // ---- 管理员操作 ----
  listApplicationsForAdmin(
    ctx: CallerContext,
    status: ApplicationStatus | 'all',
    injectedDb?: SqliteDatabase,
  ): Promise<ApplicationQueueItem[]>;
  reviewApplication(
    ctx: CallerContext,
    applicationId: string,
    decision: 'approve' | 'reject',
    note?: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<ApplicationView>;
  /**
   * 撤销身份（设计 §11）：**只打撤销标记，不动内容**。
   *
   * note 目前无处落库（user_roles 没有理由列），保留参数是为了接口签名稳定；
   * 等设计给出「撤销后处置」再决定写哪儿。
   */
  revokeRole(
    ctx: CallerContext,
    userId: string,
    roleType: RoleType,
    note?: string | null,
    injectedDb?: SqliteDatabase,
  ): Promise<MyRoleView>;
}

// ============================================================
// 内部工具
// ============================================================

interface RoleRow {
  id: string;
  user_id: string;
  role_type: RoleType;
  status: RoleStatus;
  application_id: string | null;
  granted_by: string | null;
  granted_at: number;
  revoked_by: string | null;
  revoked_at: number | null;
}

interface ApplicationRow {
  id: string;
  user_id: string;
  role_type: RoleType;
  status: ApplicationStatus;
  evidence: string | null;
  note: string | null;
  reviewer_id: string | null;
  review_note: string | null;
  created_at: number;
  reviewed_at: number | null;
  user_nickname?: string;
}

/** 申请表列清单：单表查询与 JOIN 查询共用，带表别名 t 前缀。 */
const APPLICATION_COLUMNS =
  't.id, t.user_id, t.role_type, t.status, t.evidence, t.note, t.reviewer_id, t.review_note, t.created_at, t.reviewed_at';

/** 身份中文名：错误提示与页面共用一处，免得两种叫法。 */
const ROLE_LABEL: Record<RoleType, string> = {
  reviewer: '测评员',
  developer: '开发者',
};

function isRoleType(value: unknown): value is RoleType {
  return typeof value === 'string' && (ROLE_TYPES as readonly string[]).includes(value);
}

/** 校验身份取值：不合法抛输入错误，而不是让库的 CHECK 抛裸 SQLite 错误。 */
export function parseRoleType(value: unknown): RoleType {
  if (!isRoleType(value)) {
    throw err.input('不支持的身份类型。', [{ path: 'roleType', message: `可选：${ROLE_TYPES.join(' / ')}` }]);
  }
  return value;
}

function parseApplicationStatus(value: unknown): ApplicationStatus {
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'withdrawn') return value;
  throw err.input('不支持的申请状态。', [{ path: 'status', message: 'pending / approved / rejected / withdrawn / all' }]);
}

function toRoleView(row: RoleRow): MyRoleView {
  return {
    roleType: row.role_type,
    status: row.status,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    applicationId: row.application_id,
    revokedAt: row.revoked_at,
  };
}

function toApplicationView(row: ApplicationRow): ApplicationView {
  return {
    id: row.id,
    userId: row.user_id,
    roleType: row.role_type,
    status: row.status,
    evidence: row.evidence === null ? null : (safeJson(row.evidence) as Record<string, unknown> | null),
    note: row.note,
    reviewerId: row.reviewer_id,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 表是否存在：区汇总要跨 PR 边界（forum 表属于 PR A，可能还没合进来）。 */
function tableExists(conn: SqliteDatabase, name: string): boolean {
  return conn.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** 列是否存在：forum 表的列名在 PR A 里还可能微调，取不到就跳过这一档。 */
function columnExists(conn: SqliteDatabase, table: string, column: string): boolean {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((c) => c.name === column);
}

function clampNote(raw: string | null | undefined, field: string, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;
  if (text.length > NOTE_MAX) {
    throw err.input(`${label}最多 ${NOTE_MAX} 字。`, [{ path: field, message: `最多 ${NOTE_MAX} 字` }]);
  }
  return text;
}

/** 从设置读冷却天数；库里的脏值（负数、非有限数）一律退回默认，不让一次手改把申请通道锁死。 */
function cooldownDays(conn: SqliteDatabase): number {
  const days = numberSetting(conn, COOLDOWN_DAYS_KEY, COOLDOWN_DAYS_DEFAULT);
  return Number.isFinite(days) && days >= 0 ? days : COOLDOWN_DAYS_DEFAULT;
}

/** 读用户的底座角色（身份不改变它）。用户不存在返回 null —— 调用方自己决定怎么报。 */
function baseRoleOf(conn: SqliteDatabase, userId: string): 'user' | 'admin' | null {
  const row = conn.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: 'user' | 'admin' } | undefined;
  return row ? row.role : null;
}

/**
 * 冷却期截止时刻：最近一次**被驳回**的该用户该身份申请，reviewed_at + cooldownDays。
 *
 * 为什么不取「所有 rejected 里最早的一条」：只有**最后一次**驳回有意义 —— 更早的早已过期。
 * 撤回（withdrawn）不参与：设计要求「撤回后无冷却，可立即再申请」（§3.2）。
 */
function cooldownUntilFor(
  conn: SqliteDatabase,
  userId: string,
  roleType: RoleType,
  now: number,
): number | null {
  const row = conn
    .prepare(
      `SELECT reviewed_at
         FROM role_applications
        WHERE user_id = ? AND role_type = ? AND status = 'rejected' AND reviewed_at IS NOT NULL
        ORDER BY reviewed_at DESC, id DESC
        LIMIT 1`,
    )
    .get(userId, roleType) as { reviewed_at: number } | undefined;
  if (!row) return null;
  const until = Number(row.reviewed_at) + cooldownDays(conn) * DAY;
  return until > now ? until : null;
}

// ============================================================
// 资格判定（设计 §4）
// ============================================================

/**
 * 已发布测评数。
 *
 * 口径逐字照设计 §4.1：内容实体已公开、未撤回未隐藏，且作者的**发布修订**存在。
 * 草稿（published_revision_id 为空）、待审、被驳回、已撤回一律不算。
 *
 * 为什么只看 published_revision_id 而不看 latest_submitted_revision_id：
 * 发布修订是「真正挂出去过的那一版」，再新的草稿也不会把它变成已发布。
 */
function countPublishedReviews(conn: SqliteDatabase, userId: string): number {
  const row = conn
    .prepare(
      `SELECT COUNT(*) AS c
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
        WHERE ce.author_id = ?
          AND r.published_revision_id IS NOT NULL
          AND ce.withdrawn_at IS NULL
          AND ce.hidden_at IS NULL`,
    )
    .get(userId) as { c: number };
  return Number(row.c);
}

/**
 * 资格判定（同步版，供事务内复用）。
 *
 * 与对外的 check*Eligibility 是同一口径：开发者一档与 plugin_ownerships 的
 * countVerifiedForUser 用逐字相同的 SQL —— 开发者门槛与「我的插件」必须是同一个定义。
 */
function eligibilityOf(conn: SqliteDatabase, userId: string, roleType: RoleType): EligibilityResult {
  if (roleType === 'reviewer') {
    const count = countPublishedReviews(conn, userId);
    return {
      roleType,
      eligible: count > 0,
      count,
      reason: count > 0 ? null : '还没有已发布的测评（草稿、待审、被驳回、已撤回的都不算）。',
      evidence: { reviewCount: count },
    };
  }
  const row = conn
    .prepare("SELECT COUNT(*) AS c FROM plugin_ownerships WHERE user_id = ? AND status = 'verified'")
    .get(userId) as { c: number };
  const count = Number(row.c);
  return {
    roleType,
    eligible: count > 0,
    count,
    reason: count > 0 ? null : '还没有已验证归属的插件，先去「我的插件」认领一个。',
    evidence: { verifiedPluginCount: count },
  };
}

// ============================================================
// 服务
// ============================================================

export function createRoleService(deps: { db: SqliteDatabase }): RoleService {
  const db = deps.db;
  // 复用归属服务（只为了不对同一批数据写第二份口径）。构造是同步且无副作用的，可以安全放在这里。
  const ownership = createPluginOwnershipService({ db });

  return {
    // ---------------- 资格 ----------------

    async checkReviewerEligibility(userId, injectedDb) {
      return withRead((conn) => eligibilityOf(conn, userId, 'reviewer'), injectedDb ?? db);
    },

    async checkDeveloperEligibility(userId, injectedDb) {
      // 走归属服务的公开方法，而不是在这里再写一遍 SQL：
      // 「开发者门槛」与「我的插件」必须是同一个定义，重写一份就是两份口径的开始。
      const count = await ownership.countVerifiedForUser(userId, injectedDb ?? db);
      return {
        roleType: 'developer' as RoleType,
        eligible: count > 0,
        count,
        reason: count > 0 ? null : '还没有已验证归属的插件，先去「我的插件」认领一个。',
        evidence: { verifiedPluginCount: count },
      };
    },

    async checkEligibility(roleType, userId, injectedDb) {
      return parseRoleType(roleType) === 'reviewer'
        ? this.checkReviewerEligibility(userId, injectedDb)
        : this.checkDeveloperEligibility(userId, injectedDb);
    },

    // ---------------- 读 ----------------

    async listMyRoles(ctx, injectedDb) {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      const now = nowMs();

      const view: MyRolesView = withRead((conn) => {
        const baseRole = baseRoleOf(conn, userId);
        if (baseRole === null) throw err.unavailable('用户不存在。');

        const roleRows = conn
          .prepare(
            `SELECT id, user_id, role_type, status, application_id, granted_by, granted_at, revoked_by, revoked_at
               FROM user_roles
              WHERE user_id = ?
              ORDER BY role_type`,
          )
          .all(userId) as RoleRow[];

        const appRows = conn
          .prepare(`SELECT ${APPLICATION_COLUMNS} FROM role_applications t WHERE t.user_id = ? ORDER BY t.created_at DESC, t.id DESC`)
          .all(userId) as ApplicationRow[];

        const applications = ROLE_TYPES.map((roleType) => {
          const eligibility = eligibilityOf(conn, userId, roleType);
          const held = roleRows.some((r) => r.role_type === roleType && r.status === 'active');
          const pending = appRows.find((a) => a.role_type === roleType && a.status === 'pending');
          const lastRejected = appRows.find((a) => a.role_type === roleType && a.status === 'rejected');
          return {
            roleType,
            eligible: eligibility.eligible,
            count: eligibility.count,
            reason: eligibility.reason,
            held,
            pendingApplicationId: pending ? pending.id : null,
            cooldownUntil: cooldownUntilFor(conn, userId, roleType, now),
            lastRejectedApplicationId: lastRejected ? lastRejected.id : null,
          };
        });

        return {
          userId,
          baseRole,
          roles: roleRows.map(toRoleView),
          boardModerators: readBoardModerators(conn, userId),
          applications,
          history: appRows.map(toApplicationView),
        };
      }, injectedDb ?? db);
      return view;
    },

    async listActiveRoles(userId, injectedDb) {
      return withRead((conn) => {
        const rows = conn
          .prepare("SELECT role_type FROM user_roles WHERE user_id = ? AND status = 'active' ORDER BY role_type")
          .all(userId) as Array<{ role_type: RoleType }>;
        return rows.map((r) => r.role_type);
      }, injectedDb ?? db);
    },

    async hasRole(ctx, roleType, injectedDb) {
      if (ctx.userId === null || ctx.accountStatus !== 'active') return false;
      const roles = await this.listActiveRoles(ctx.userId, injectedDb);
      return roles.includes(roleType);
    },

    isBaseAdmin(userId, injectedDb) {
      return withRead((conn) => baseRoleOf(conn, userId), injectedDb ?? db);
    },

    // ---------------- 申请人操作 ----------------

    async applyForRole(ctx, roleType, note, injectedDb) {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const type = parseRoleType(roleType);
      const cleanNote = clampNote(note, 'note', '申请说明');

      return withTransaction((tx) => {
        const conn = tx.db;
        const now = nowMs();

        // 1) 已持有该身份：没有可申请的（§5.1「已是测评员，无需申请」）。
        const existingRole = conn
          .prepare('SELECT id, status FROM user_roles WHERE user_id = ? AND role_type = ?')
          .get(userId, type) as { id: string; status: RoleStatus } | undefined;
        if (existingRole && existingRole.status === 'active') {
          throw err.conflict(`你已经是${ROLE_LABEL[type]}了，无需重复申请。`);
        }

        // 2) 已有待审申请：库里有部分唯一索引兜底，这里提前给人话。
        const pending = conn
          .prepare("SELECT id FROM role_applications WHERE user_id = ? AND role_type = ? AND status = 'pending'")
          .get(userId, type) as { id: string } | undefined;
        if (pending) throw err.conflict('已有一条待审核的申请，请等待管理员处理。');

        // 3) 冷却期：最近一次驳回 + 冷却天数还没过（天数读设置项，管理员可调）。
        const until = cooldownUntilFor(conn, userId, type, now);
        if (until !== null) {
          // 向上取整且至少 1 天：剩 0.4 天时说「0 天后可申请」会让人以为马上就能点。
          const remainingDays = Math.max(1, Math.ceil((until - now) / DAY));
          throw err.rateLimited(
            `上次申请被驳回，请 ${remainingDays} 天后再申请。`,
            { retryAfterDays: remainingDays, cooldownUntil: until },
          );
        }

        // 4) 资格：不够就说清缺什么（页面按钮置灰靠同一判定，§5.1）。
        const eligibility = eligibilityOf(conn, userId, type);
        if (!eligibility.eligible) {
          const why = eligibility.reason ?? '资格不足';
          throw err.input(`暂时不满足${ROLE_LABEL[type]}的申请条件：${why}`, [{ path: 'roleType', message: why }]);
        }

        // 5) 落申请。资格数字快照进 evidence —— 审核时不让现算（§3.2）。
        const id = newId(now);
        conn
          .prepare(
            `INSERT INTO role_applications
               (id, user_id, role_type, status, evidence, note, reviewer_id, review_note, created_at, reviewed_at)
             VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, NULL)`,
          )
          .run(id, userId, type, JSON.stringify(eligibility.evidence), cleanNote, now);

        return toApplicationView(loadApplication(conn, id));
      }, injectedDb ?? db);
    },

    async withdrawApplication(ctx, applicationId, injectedDb) {
      assertCanWrite(ctx);
      const userId = ctx.userId;

      return withTransaction((tx) => {
        const conn = tx.db;
        const row = conn
          .prepare('SELECT id, user_id, status FROM role_applications WHERE id = ?')
          .get(applicationId) as { id: string; user_id: string; status: ApplicationStatus } | undefined;
        if (!row) throw err.unavailable('申请不存在。');
        // 别人的申请一律按「不可访问」处理，不泄露存在性。
        if (row.user_id !== userId) throw err.unavailable('申请不存在。');
        if (row.status !== 'pending') throw err.conflict('只有待审核的申请可以撤回。');

        // withdrawn 不带 reviewer_id / reviewed_at（库里 CHECK 要求这两者与 approved/rejected 同进退），
        // 也不参与冷却期判定 —— 撤回后可以立即再申请（§3.2）。
        conn.prepare("UPDATE role_applications SET status = 'withdrawn' WHERE id = ?").run(applicationId);

        return toApplicationView(loadApplication(conn, applicationId));
      }, injectedDb ?? db);
    },

    // ---------------- 管理员操作 ----------------

    async listApplicationsForAdmin(ctx, status, injectedDb) {
      // 入参校验放在最前、且在 withRead 之外：
      // async 方法里任何同步 throw 都会变成 rejected promise —— 若再套进 withRead 的回调，
      // 调用方拿到的是一条「成功」而不是错误。踩过这个坑，别把校验挪回回调里。
      const filter = status === 'all' ? 'all' : parseApplicationStatus(status);
      // 鉴权再查库：先认人再校验入参的顺序与接口层（先认人再读 body）保持一致。
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以查看身份申请队列。');
      return withRead((conn) => {
        const where = filter === 'all' ? '' : 'WHERE t.status = ?';
        const args = filter === 'all' ? [] : [filter];
        // 待审队列按提交先后（先到先审）；已处理列表按时间倒序（最近处理的最关心）。
        const order = filter === 'pending' ? 'ASC' : 'DESC';
        const rows = conn
          .prepare(
            `SELECT ${APPLICATION_COLUMNS}, u.nickname AS user_nickname
               FROM role_applications t
               JOIN users u ON u.id = t.user_id
               ${where}
              ORDER BY t.created_at ${order}, t.id`,
          )
          .all(...args) as ApplicationRow[];
        return rows.map((row) => ({ ...toApplicationView(row), userNickname: row.user_nickname ?? '' }));
      }, injectedDb ?? db);
    },

    async reviewApplication(ctx, applicationId, decision, note, injectedDb) {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核身份申请。');
      const adminId = ctx.userId;
      if (decision !== 'approve' && decision !== 'reject') {
        throw err.input('审核结论只能是 approve 或 reject。', [{ path: 'decision', message: 'approve / reject' }]);
      }
      const cleanNote = clampNote(note, 'reviewNote', '审核批注');

      return withTransaction((tx) => {
        const conn = tx.db;
        const row = conn
          .prepare('SELECT id, user_id, role_type, status FROM role_applications WHERE id = ?')
          .get(applicationId) as
          | { id: string; user_id: string; role_type: RoleType; status: ApplicationStatus }
          | undefined;
        if (!row) throw err.unavailable('申请不存在。');
        if (row.status !== 'pending') throw err.conflict('这条申请已经处理过了。');

        const now = nowMs();
        if (decision === 'approve') {
          // 通过：同事务写 user_roles —— 不能出现「申请批了但身份没给」的中间态。
          conn
            .prepare(
              `UPDATE role_applications
                  SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = ?
                WHERE id = ?`,
            )
            .run(adminId, cleanNote, now, applicationId);

          grantRoleRow(conn, {
            userId: row.user_id,
            roleType: row.role_type,
            // isAdmin(ctx) 已经断言 userId 非空；这里再收窄一次，免得把 null 传进外键列。
            adminId: adminId as string,
            applicationId,
            now,
          });
        } else {
          // 驳回：只动申请表。user_roles 不碰 —— 他本来就没有这个身份。
          conn
            .prepare(
              `UPDATE role_applications
                  SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = ?
                WHERE id = ?`,
            )
            .run(adminId, cleanNote, now, applicationId);
        }

        // 结果通知与审核结论在**同一个事务**里投递（设计 §7）。
        // 投递函数返回 DeliverResult、不抛业务错，因此通知发不出去不会回滚审核结论；
        // 去重键带 result，「驳回 → 补材料 → 通过」各发一条、同一结论重放只发一条。
        const roleLabel = row.role_type === 'reviewer' ? '测评员' : '开发者';
        deliverRoleApplicationResultNotification(conn, {
          recipientId: row.user_id,
          actorId: adminId as string,
          detail:
            decision === 'approve'
              ? `你的${roleLabel}身份申请已通过。`
              : `你的${roleLabel}身份申请未通过${cleanNote ? `：${cleanNote}` : '。'}`,
          linkUrl: '/me/settings',
          deduplicationKey: `role_application:${applicationId}:${row.user_id}:${decision}`,
          now,
        });

        return toApplicationView(loadApplication(conn, applicationId));
      }, injectedDb ?? db);
    },

    async revokeRole(ctx, userId, roleType, note, injectedDb) {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以撤销身份。');
      const adminId = ctx.userId;
      const type = parseRoleType(roleType);
      // 只说一句实话：撤销理由当前**无处落库**（user_roles 没有理由列，也不该改写历史申请表）。
      // 这里仍然做长度校验，是为了将来加上列时接口行为不用改。
      clampNote(note, 'note', '撤销说明');

      return withTransaction((tx) => {
        const conn = tx.db;
        const row = conn
          .prepare('SELECT id, status FROM user_roles WHERE user_id = ? AND role_type = ?')
          .get(userId, type) as { id: string; status: RoleStatus } | undefined;
        if (!row) throw err.unavailable('该用户没有这个身份。');
        if (row.status === 'revoked') throw err.conflict('这个身份已经被撤销过了。');

        const now = nowMs();
        // 只打标记：**不动**该用户的评测与插件（§11 使用者裁定「撤销后的处置」暂未设计）。
        conn
          .prepare("UPDATE user_roles SET status = 'revoked', revoked_by = ?, revoked_at = ? WHERE id = ?")
          .run(adminId, now, row.id);

        const after = conn
          .prepare(
            `SELECT id, user_id, role_type, status, application_id, granted_by, granted_at, revoked_by, revoked_at
               FROM user_roles WHERE id = ?`,
          )
          .get(row.id) as RoleRow;
        return toRoleView(after);
      }, injectedDb ?? db);
    },
  };
}


// ============================================================
// 内部：事务内的小工具
// ============================================================

function loadApplication(conn: SqliteDatabase, applicationId: string): ApplicationRow {
  return conn.prepare(`SELECT ${APPLICATION_COLUMNS} FROM role_applications t WHERE t.id = ?`).get(applicationId) as ApplicationRow;
}

/**
 * 授予一行身份：已有记录（曾被撤销）就改回 active 并更新授予信息，没有就新建。
 *
 * 为什么复用同一行：迁移 0040 的 UNIQUE(user_id, role_type) 就是这么设计的 ——
 * 同类身份只有一条记录，完整的授予/撤销历史留在 role_applications 里（§3.1）。
 *
 * 改回 active 时必须同时把 revoked_by / revoked_at 置空：
 * 库里有 CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)) 这类成对约束，
 * 只改 status 会当场撞约束（SQLite 里「false = true」为 false，不会替你放行）。
 */
function grantRoleRow(
  conn: SqliteDatabase,
  input: { userId: string; roleType: RoleType; adminId: string; applicationId: string; now: number },
): void {
  const existing = conn
    .prepare('SELECT id FROM user_roles WHERE user_id = ? AND role_type = ?')
    .get(input.userId, input.roleType) as { id: string } | undefined;

  if (existing) {
    conn
      .prepare(
        `UPDATE user_roles
            SET status = 'active', application_id = ?, granted_by = ?, granted_at = ?,
                revoked_by = NULL, revoked_at = NULL
          WHERE id = ?`,
      )
      .run(input.applicationId, input.adminId, input.now, existing.id);
    return;
  }

  conn
    .prepare(
      `INSERT INTO user_roles
         (id, user_id, role_type, status, application_id, granted_by, granted_at, revoked_by, revoked_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, NULL)`,
    )
    .run(newId(input.now), input.userId, input.roleType, input.applicationId, input.adminId, input.now);
}

/**
 * 读该用户的讨论区区长/协管（只读展示，设计 §3.4）。
 *
 * 表**可能不存在**：forum_board_moderators 是 PR A（讨论区）的内容，本分支上可能还没合进来。
 * 所以先查 sqlite_master，没有就直接返回空数组 —— 不能让「我的身份」页因为一张
 * 尚未存在的表整个 500。板块表与列名同理按存在性取，缺哪个就回退哪一档。
 */
function readBoardModerators(conn: SqliteDatabase, userId: string): BoardModeratorSummary[] {
  if (!tableExists(conn, 'forum_board_moderators')) return [];

  const boardTable = tableExists(conn, 'forum_boards') ? 'forum_boards' : null;
  const hasSlug = boardTable !== null && columnExists(conn, boardTable, 'slug');
  const hasName = boardTable !== null && columnExists(conn, boardTable, 'name');
  const boardCols =
    boardTable === null
      ? 'NULL AS board_slug, NULL AS board_name'
      : `${hasSlug ? 'b.slug' : 'NULL'} AS board_slug, ${hasName ? 'b.name' : 'NULL'} AS board_name`;
  const join = boardTable === null ? '' : `LEFT JOIN ${boardTable} b ON b.id = m.board_id`;

  const rows = conn
    .prepare(
      `SELECT m.board_id AS board_id, m.role AS role, ${boardCols}
         FROM forum_board_moderators m
         ${join}
        WHERE m.user_id = ?
        ORDER BY m.board_id`,
    )
    .all(userId) as Array<{ board_id: string; role: string; board_slug: string | null; board_name: string | null }>;

  return rows.map((row) => ({
    boardId: row.board_id,
    boardSlug: row.board_slug,
    // 名字缺了也要能显示：回退成板块 id 而不是空串，否则页面会出现一条没有标题的身份。
    boardName: row.board_name ?? row.board_id,
    role: row.role,
  }));
}

// ============================================================
// 进程级单例（与其它模块一致）
// ============================================================

let singleton: RoleService | null = null;
export function roleService(): RoleService {
  if (!singleton) singleton = createRoleService({ db: getDb() });
  return singleton;
}
export function resetRoleService(): void {
  singleton = null;
}

// ============================================================
// 兼容别名
// ============================================================

/**
 * 复数形式的工厂名。
 *
 * 页面与接口层（admin/roles 页、/api/me/roles/applications、/api/admin/role-applications）
 * 先于本服务落地时就按 createRolesService 写了转发，这里补一个逐字等价的别名，
 * 免得为了一个 s 去改四个调用点。新代码请用 createRoleService。
 */
export const createRolesService = createRoleService;
