/**
 * 讨论区 · 分区与权限。
 *
 * 权限模型（设计文档 §3.1、§5）：
 *   * 分区权限**只在分区内生效** —— forum_board_moderators 不写进 users.role，
 *     "站长"和"某个区的区长"是两件事，混在一起会让"这个人凭什么能删帖"难以追溯。
 *   * 发帖判定顺序：站方管理员 → 放行；分区 owner → 放行；
 *     命中 deny → 拒绝；whitelist 且不在 allow → 拒绝；admin_only → 拒绝；否则放行。
 *     "先放行再拒绝"的顺序是有意的：黑名单必须能盖过白名单，否则被踢出的人
 *     只要还在 allow 名单里就踢不掉。
 *   * owner 不能被协管罢免，只能被站方管理员罢免（D6）。
 */

import { assertCanAdmin, assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import {
  normalizeBoardSlug,
  type BoardMemberRole,
  type BoardStatus,
  type PostingPolicy,
} from '@/packages/common/forum';

// ============================================================
// 视图
// ============================================================

export interface BoardView {
  boardId: string;
  slug: string;
  name: string;
  description: string;
  postingPolicy: PostingPolicy;
  isOfficial: boolean;
  status: BoardStatus;
  ownerId: string | null;
  /** 当前调用者能否在本区发帖（只有登录用户才有意义，匿名一律 false）。 */
  canPost: boolean;
  createdAt: number;
}

export interface BoardMemberView {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  role: BoardMemberRole;
  grantedBy: string | null;
  createdAt: number;
}

interface BoardRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  posting_policy: PostingPolicy;
  is_official: number;
  status: BoardStatus;
  owner_id: string | null;
  created_at: number;
}

function toBoardView(row: BoardRow, canPost: boolean): BoardView {
  return {
    boardId: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    postingPolicy: row.posting_policy,
    isOfficial: row.is_official === 1,
    status: row.status,
    ownerId: row.owner_id,
    canPost,
    createdAt: row.created_at,
  };
}

// ============================================================
// 权限判定（纯函数，便于单测直接测）
// ============================================================

export interface PostingDecisionInput {
  policy: PostingPolicy;
  boardStatus: BoardStatus;
  /** 调用者是否为站方管理员。 */
  admin: boolean;
  /** 调用者在本区的角色；不在本区任职为 null。 */
  boardRole: BoardMemberRole | null;
  /** 调用者在白/黑名单中的状态。 */
  rule: 'allow' | 'deny' | null;
}

/**
 * 编辑权限。
 *
 * 设计文档 §5 的权限表：**编辑帖子 = 作者 / 站方管理员 / 分区 owner**，
 * 协管（moderator）只有软删与置顶，没有编辑。帖子正文是作者的署名作品，
 * 让协管改字等于替别人发言——这与"协管能下架违规内容"是两件事。
 *
 * 放在这里而不是 posts.ts：权限判定只有一份，帖子服务与将来任何
 * 编辑入口都走同一个函数，避免两处各写一套再漂移。
 */
export function decideEdit(input: {
  /** 调用者是不是帖子作者。 */
  isAuthor: boolean;
  /** 站方管理员。 */
  admin: boolean;
  /** 调用者在本区的角色；不在本区任职为 null。 */
  boardRole: BoardMemberRole | null;
}): { allowed: boolean; reason: string } {
  if (input.isAuthor) return { allowed: true, reason: '' };
  if (input.admin) return { allowed: true, reason: '' };
  if (input.boardRole === 'owner') return { allowed: true, reason: '' };
  return { allowed: false, reason: '只有作者、分区区长或站方管理员可以编辑该帖。' };
}

/**
 * 判断能否在本区发帖。
 *
 * 返回 { allowed, reason }：拒绝时给出可读原因，页面直接展示，
 * 不用把"为什么我不能发"留给用户猜。
 */
export function decidePosting(input: PostingDecisionInput): { allowed: boolean; reason: string } {
  if (input.boardStatus === 'archived') {
    return { allowed: false, reason: '该分区已归档，只能阅读。' };
  }
  // 站方管理员与分区 owner 始终可发（否则官方公告区没人发得出来）
  if (input.admin) return { allowed: true, reason: '' };
  if (input.boardRole === 'owner') return { allowed: true, reason: '' };
  // 黑名单优先于白名单
  if (input.rule === 'deny') {
    return { allowed: false, reason: '你已被限制在该分区发帖。' };
  }
  if (input.policy === 'admin_only') {
    return { allowed: false, reason: '该分区仅管理员可发帖。' };
  }
  if (input.policy === 'whitelist' && input.rule !== 'allow') {
    return { allowed: false, reason: '该分区仅白名单用户可发帖。' };
  }
  return { allowed: true, reason: '' };
}

// ============================================================
// 服务
// ============================================================

export interface ForumBoardService {
  listBoards(ctx: CallerContext): Promise<BoardView[]>;
  getBoard(ctx: CallerContext, slug: string): Promise<BoardView>;
  /** 分区详情页需要的权限上下文：调用者能否发帖、是否为该区管理者。 */
  canPostIn(ctx: CallerContext, boardId: string): Promise<{ allowed: boolean; reason: string }>;
  listMembers(ctx: CallerContext, boardId: string): Promise<BoardMemberView[]>;
  /** 任命协管（owner 或站方管理员）。 */
  appointModerator(ctx: CallerContext, boardId: string, userId: string): Promise<void>;
  /** 罢免协管（owner 或站方管理员）；owner 只能由站方管理员罢免。 */
  removeModerator(ctx: CallerContext, boardId: string, userId: string): Promise<void>;
  /** 转移 owner（仅站方管理员）。 */
  transferOwner(ctx: CallerContext, boardId: string, userId: string): Promise<void>;
  /** 设置发帖策略（owner 或站方管理员）。 */
  setPostingPolicy(ctx: CallerContext, boardId: string, policy: PostingPolicy): Promise<void>;
  /** 设置某人在本区的白/黑名单（owner 或站方管理员）；mode=null 表示清除。 */
  setPostingRule(ctx: CallerContext, boardId: string, userId: string, mode: 'allow' | 'deny' | null): Promise<void>;
  /** 归档 / 恢复分区（仅站方管理员）。 */
  setBoardStatus(ctx: CallerContext, boardId: string, status: BoardStatus): Promise<void>;
  /** 调用者在本区的角色；不在本区任职返回 null。 */
  boardRoleOf(boardId: string, userId: string): Promise<BoardMemberRole | null>;
}

export function createForumBoardService(deps: { db: SqliteDatabase }): ForumBoardService {
  const { db } = deps;

  function readBoardRow(conn: SqliteDatabase, key: { id?: string; slug?: string }): BoardRow {
    const row = (
      key.id !== undefined
        ? conn.prepare('SELECT * FROM forum_boards WHERE id = ?').get(key.id)
        : conn.prepare('SELECT * FROM forum_boards WHERE slug = ?').get(key.slug)
    ) as BoardRow | undefined;
    if (!row) throw err.unavailable('分区不存在。');
    return row;
  }

  function roleOf(conn: SqliteDatabase, boardId: string, userId: string | null): BoardMemberRole | null {
    if (userId === null) return null;
    const row = conn
      .prepare('SELECT role FROM forum_board_moderators WHERE board_id = ? AND user_id = ?')
      .get(boardId, userId) as { role: BoardMemberRole } | undefined;
    return row ? row.role : null;
  }

  function ruleOf(conn: SqliteDatabase, boardId: string, userId: string | null): 'allow' | 'deny' | null {
    if (userId === null) return null;
    const row = conn
      .prepare('SELECT mode FROM forum_board_posting_rules WHERE board_id = ? AND user_id = ?')
      .get(boardId, userId) as { mode: 'allow' | 'deny' } | undefined;
    return row ? row.mode : null;
  }

  function decide(conn: SqliteDatabase, ctx: CallerContext, row: BoardRow) {
    if (ctx.userId === null) {
      return { allowed: false, reason: '请先登录。' };
    }
    return decidePosting({
      policy: row.posting_policy,
      boardStatus: row.status,
      admin: isAdmin(ctx),
      boardRole: roleOf(conn, row.id, ctx.userId),
      rule: ruleOf(conn, row.id, ctx.userId),
    });
  }

  /** 管理动作的统一前置：站方管理员，或本区 owner。 */
  function assertBoardManager(conn: SqliteDatabase, ctx: CallerContext, row: BoardRow): void {
    if (isAdmin(ctx)) return;
    if (ctx.userId !== null && roleOf(conn, row.id, ctx.userId) === 'owner') return;
    throw err.forbidden('该操作需要站方管理员或本分区区长权限。');
  }

  return {
    async listBoards(ctx) {
      // 读路径**不写库**：分区为空时这里补建一次（幂等），但补建走的是
      // "捕获唯一约束冲突后重读"而不是裸写——两个并发的首次访问会同时看到
      // 空表，各自 INSERT，后到的那个撞 uq_forum_boards_slug，匿名浏览
      // 首页就变成 500。谁先插进去都行，结果一样，所以撞了就重读。
      ensureDefaultBoardsQuietly(db);
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT * FROM forum_boards
              ORDER BY is_official DESC, status = 'archived', name`,
          )
          .all() as BoardRow[];
        return rows.map((row) => toBoardView(row, decide(conn, ctx, row).allowed));
      }, db);
    },

    async getBoard(ctx, slug) {
      return withRead((conn) => {
        const row = readBoardRow(conn, { slug: normalizeBoardSlug(slug) });
        return toBoardView(row, decide(conn, ctx, row).allowed);
      }, db);
    },

    async canPostIn(ctx, boardId) {
      return withRead((conn) => decide(conn, ctx, readBoardRow(conn, { id: boardId })), db);
    },

    async listMembers(_ctx, boardId) {
      return withRead((conn) => {
        readBoardRow(conn, { id: boardId });
        const rows = conn
          .prepare(
            `SELECT m.user_id, m.role, m.granted_by, m.created_at, u.nickname, u.avatar_url
               FROM forum_board_moderators m
               JOIN users u ON u.id = m.user_id
              WHERE m.board_id = ?
              ORDER BY m.role = 'moderator', m.created_at`,
          )
          .all(boardId) as Array<{
          user_id: string;
          role: BoardMemberRole;
          granted_by: string | null;
          created_at: number;
          nickname: string;
          avatar_url: string | null;
        }>;
        return rows.map((r) => ({
          userId: r.user_id,
          nickname: r.nickname,
          avatarUrl: r.avatar_url,
          role: r.role,
          grantedBy: r.granted_by,
          createdAt: r.created_at,
        }));
      }, db);
    },

    async appointModerator(ctx, boardId, userId) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readBoardRow(conn, { id: boardId });
        assertBoardManager(conn, ctx, row);

        // 目标必须是存在的活跃用户
        const target = conn
          .prepare('SELECT account_status FROM users WHERE id = ?')
          .get(userId) as { account_status: string } | undefined;
        if (!target) throw err.input('找不到该用户。', [{ path: 'userId', message: '未知用户' }]);
        if (target.account_status !== 'active') {
          throw err.input('该用户账户不可用。', [{ path: 'userId', message: '账户非活跃' }]);
        }

        const existing = roleOf(conn, boardId, userId);
        if (existing === 'owner') {
          throw err.input('对方已是本区区长。', [{ path: 'userId', message: '重复任命' }]);
        }
        if (existing === 'moderator') return; // 幂等
        conn
          .prepare(
            'INSERT INTO forum_board_moderators (board_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(boardId, userId, 'moderator', ctx.userId, nowMs());
      }, db);
    },

    async removeModerator(ctx, boardId, userId) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readBoardRow(conn, { id: boardId });
        const targetRole = roleOf(conn, boardId, userId);
        if (targetRole === null) return; // 幂等：本来就不在任

        // 「不能撤销自己」要在「只有管理员能撤 owner」之前判：
        // 区长点自己的撤销，真正的问题是"不该有这个动作"，而不是"你权限不够"。
        // 反过来的顺序会把 owner 的自撤销误报成 403，让人以为是被别人挡了。
        if (userId === ctx.userId) {
          throw err.input('不能撤销自己的身份，请先转移区长身份。', [
            { path: 'userId', message: '不能操作自己' },
          ]);
        }

        // owner 只能被站方管理员罢免（D6）：协管不能反过来架空区长
        if (targetRole === 'owner' && !isAdmin(ctx)) {
          throw err.forbidden('只能由站方管理员撤销区长。');
        }
        if (targetRole === 'moderator') assertBoardManager(conn, ctx, row);

        conn
          .prepare('DELETE FROM forum_board_moderators WHERE board_id = ? AND user_id = ?')
          .run(boardId, userId);
        // 撤销 owner 必须同时清掉 forum_boards.owner_id：它不只是展示字段，
        // 还是"这个区的区长是谁"的权威副本。只删关系表会让分区列表继续挂着
        // 一个已被罢免的人，而 transferOwner 又拿它做幂等判断——
        // 于是"撤销 → 重新任命同一人"变成了 no-op，人回不来。
        if (targetRole === 'owner' || row.owner_id === userId) {
          conn
            .prepare('UPDATE forum_boards SET owner_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ?')
            .run(nowMs(), boardId, userId);
        }
      }, db);
    },

    async transferOwner(ctx, boardId, userId) {
      assertCanAdmin(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readBoardRow(conn, { id: boardId });
        const target = conn.prepare('SELECT id FROM users WHERE id = ?').get(userId) as
          | { id: string }
          | undefined;
        if (!target) throw err.input('找不到该用户。', [{ path: 'userId', message: '未知用户' }]);
        // 幂等判据看**两处**：分区上的 owner_id 与关系表里的角色。
        // 只比 owner_id 不够——历史数据里 owner 被撤销后 owner_id 可能没清，
        // 那时"重新任命同一人"会被误判成 no-op，人回不来。
        if (row.owner_id === userId && roleOf(conn, boardId, userId) === 'owner') return;

        const now = nowMs();
        // 先把旧 owner 降为协管（保留其管理能力），再把新 owner 升上去
        if (row.owner_id !== null) {
          conn
            .prepare(
              `UPDATE forum_board_moderators SET role = 'moderator'
                WHERE board_id = ? AND user_id = ?`,
            )
            .run(boardId, row.owner_id);
        }
        conn
          .prepare(
            `INSERT INTO forum_board_moderators (board_id, user_id, role, granted_by, created_at)
             VALUES (?, ?, 'owner', ?, ?)
             ON CONFLICT(board_id, user_id) DO UPDATE SET role = 'owner', granted_by = excluded.granted_by`,
          )
          .run(boardId, userId, ctx.userId, now);
        conn.prepare('UPDATE forum_boards SET owner_id = ?, updated_at = ? WHERE id = ?').run(userId, now, boardId);
      }, db);
    },

    async setPostingPolicy(ctx, boardId, policy) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readBoardRow(conn, { id: boardId });
        assertBoardManager(conn, ctx, row);
        // 官方公告区不允许被改成 everyone —— 这是站方的底线，不是区长的自由
        if (row.is_official === 1 && policy !== 'admin_only') {
          throw err.input('官方分区的发帖策略固定为仅管理员。', [{ path: 'policy', message: '官方分区不可修改' }]);
        }
        conn
          .prepare('UPDATE forum_boards SET posting_policy = ?, updated_at = ? WHERE id = ?')
          .run(policy, nowMs(), boardId);
      }, db);
    },

    async setPostingRule(ctx, boardId, userId, mode) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readBoardRow(conn, { id: boardId });
        assertBoardManager(conn, ctx, row);
        if (mode === null) {
          conn
            .prepare('DELETE FROM forum_board_posting_rules WHERE board_id = ? AND user_id = ?')
            .run(boardId, userId);
          return;
        }
        const target = conn.prepare('SELECT id FROM users WHERE id = ?').get(userId) as
          | { id: string }
          | undefined;
        if (!target) throw err.input('找不到该用户。', [{ path: 'userId', message: '未知用户' }]);
        conn
          .prepare(
            `INSERT INTO forum_board_posting_rules (board_id, user_id, mode, created_by, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(board_id, user_id) DO UPDATE SET mode = excluded.mode, created_by = excluded.created_by`,
          )
          .run(boardId, userId, mode, ctx.userId, nowMs());
      }, db);
    },

    async setBoardStatus(ctx, boardId, status) {
      assertCanAdmin(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readBoardRow(conn, { id: boardId });
        // 官方分区不允许归档：公告要一直可读
        if (row.is_official === 1 && status === 'archived') {
          throw err.input('官方分区不能被归档。', [{ path: 'status', message: '官方分区固定为正常' }]);
        }
        conn.prepare('UPDATE forum_boards SET status = ?, updated_at = ? WHERE id = ?').run(status, nowMs(), boardId);
      }, db);
    },

    async boardRoleOf(boardId, userId) {
      return withRead((conn) => roleOf(conn, boardId, userId), db);
    },
  };
}

// ============================================================
// 默认分区兜底
// ============================================================

/** SQLite 唯一约束冲突（better-sqlite3 把扩展错误码放在 code 上）。 */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * 读路径用的补建：与 `ensureDefaultBoards` 同一份数据，但**冲突即吞掉**。
 *
 * 浏览分区列表是匿名可做的只读操作，它不该因为"另一个请求刚好在建默认分区"
 * 而回 500。真正写失败（比如库只读、磁盘满）仍然要抛——那说明系统坏了，
 * 吞掉只会把一个明确的问题变成"分区列表莫名是空的"。
 */
function ensureDefaultBoardsQuietly(db: SqliteDatabase): void {
  try {
    ensureDefaultBoards(db);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

/**
 * 保证默认分区存在。
 *
 * 迁移里插种子时要求"库里至少有一个用户"（created_by 非空），全新库安装时
 * 可能还没有用户，所以这里在第一个用户出现后补建一次。幂等。
 */
export function ensureDefaultBoards(db: SqliteDatabase): void {
  withTransaction((tx) => {
    const conn = tx.db;
    const anyUser = conn.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as
      | { id: string }
      | undefined;
    if (!anyUser) return;

    const existing = conn.prepare('SELECT COUNT(*) AS c FROM forum_boards').get() as { c: number };
    if (Number(existing.c) > 0) return;

    const now = nowMs();
    const seeds: Array<[slug: string, name: string, description: string, policy: PostingPolicy, official: number]> = [
      [
        'announcements',
        '测评站官方公告',
        '站方发布的公告与说明。',
        'admin_only',
        1,
      ],
      ['general', '综合讨论', '插件、评测、整合包之外的一切，都可以在这里聊。', 'everyone', 0],
    ];
    for (const [slug, name, description, policy, official] of seeds) {
      conn
        .prepare(
          `INSERT INTO forum_boards
             (id, slug, name, description, posting_policy, is_official, status, owner_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
        )
        .run(newId(), slug, name, description, policy, official, anyUser.id, now, now);
    }
  }, db);
}
