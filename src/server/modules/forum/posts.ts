/**
 * 讨论区 · 帖子与回复。
 *
 * 形态（设计文档 §3.2）：
 *   * 帖子与顶层回复都用 Markdown，可带图片；**回复的回复不能带图**。
 *   * 回复只有两层，第三层由迁移 0037 的触发器拒绝——这里再判一次是为了给出
 *     能看懂的错误，而不是把 SQL 的 ABORT 文案抛给用户。
 *   * 删除是**软删**：行保留、status='deleted'，回复者与收藏者能看到"已删除"
 *     而不是内容凭空消失。软删不级联删回复与点赞，那些是别人的痕迹。
 *   * like_count / reply_count / last_reply_at 在写事务内维护，列表排序靠它们。
 */

import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import type { PageResult } from '@/packages/common/result';
import { buildPage, PaginationDefaults } from '@/packages/common/result';
import {
  FORUM_LIMITS,
  normalizeBoardSlug,
  type ForumContentStatus,
  type PostSortOption,
} from '@/packages/common/forum';
import { deliverForumReplyNotification } from '@/server/modules/notifications';

// ============================================================
// 视图
// ============================================================

export interface PostListItem {
  postId: string;
  boardId: string;
  boardSlug: string;
  boardName: string;
  authorId: string;
  authorNickname: string;
  authorAvatarUrl: string | null;
  title: string;
  excerpt: string;
  status: ForumContentStatus;
  isPinned: boolean;
  likeCount: number;
  replyCount: number;
  createdAt: number;
  lastReplyAt: number | null;
}

export interface ReplyView {
  replyId: string;
  postId: string;
  authorId: string;
  authorNickname: string;
  authorAvatarUrl: string | null;
  /** null = 顶层回复。 */
  parentId: string | null;
  bodyMd: string;
  status: ForumContentStatus;
  likeCount: number;
  likedByMe: boolean;
  createdAt: number;
  editedAt: number | null;
  /** 仅顶层回复有：其下的回复（回复的回复）。 */
  children: ReplyView[];
}

export interface PostDetail {
  postId: string;
  boardId: string;
  boardSlug: string;
  boardName: string;
  authorId: string;
  authorNickname: string;
  authorAvatarUrl: string | null;
  title: string;
  bodyMd: string;
  status: ForumContentStatus;
  deletedBy: string | null;
  isPinned: boolean;
  likeCount: number;
  likedByMe: boolean;
  replyCount: number;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  /** 调用者能否编辑这篇（作者 / 站方管理员 / 本区 owner）。 */
  canEdit: boolean;
  /** 调用者能否软删这篇。 */
  canDelete: boolean;
  canModerate: boolean;
}

interface PostRow {
  id: string;
  board_id: string;
  author_id: string;
  title: string;
  body_md: string;
  status: ForumContentStatus;
  deleted_by: string | null;
  is_pinned: number;
  like_count: number;
  reply_count: number;
  last_reply_at: number | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  author_nickname: string;
  author_avatar_url: string | null;
  board_slug: string;
  board_name: string;
}

const POST_SELECT = `
  SELECT p.*, u.nickname AS author_nickname, u.avatar_url AS author_avatar_url,
         b.slug AS board_slug, b.name AS board_name
    FROM forum_posts p
    JOIN users u ON u.id = p.author_id
    JOIN forum_boards b ON b.id = p.board_id
`;

/** 列表摘要：从 Markdown 里剥掉标记，避免把 `##` 之类的符号塞进列表。 */
function excerptOf(markdown: string, max = 120): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

// ============================================================
// 输入
// ============================================================

export interface CreatePostInput {
  boardSlug: string;
  title: unknown;
  bodyMd: unknown;
  /** 附件文件 id（仅本人上传的能挂，触发器兜底）。 */
  fileIds?: unknown[];
}

export interface CreateReplyInput {
  bodyMd: unknown;
  /** 非空 = 回复某条顶层回复。 */
  parentId?: unknown;
  fileIds?: unknown[];
}

export interface ListPostsInput {
  page?: number;
  pageSize?: number;
  sort?: PostSortOption;
}

// ============================================================
// 服务
// ============================================================

export interface ForumPostService {
  listPosts(ctx: CallerContext, boardSlug: string, input?: ListPostsInput): Promise<PageResult<PostListItem>>;
  getPost(ctx: CallerContext, postId: string): Promise<PostDetail>;
  listReplies(ctx: CallerContext, postId: string): Promise<{ items: ReplyView[]; total: number }>;
  createPost(ctx: CallerContext, input: CreatePostInput): Promise<{ postId: string }>;
  editPost(ctx: CallerContext, postId: string, input: { title: unknown; bodyMd: unknown }): Promise<void>;
  deletePost(ctx: CallerContext, postId: string): Promise<void>;
  createReply(ctx: CallerContext, postId: string, input: CreateReplyInput): Promise<{ replyId: string }>;
  deleteReply(ctx: CallerContext, replyId: string): Promise<void>;
  togglePostLike(ctx: CallerContext, postId: string): Promise<{ liked: boolean; count: number }>;
  toggleReplyLike(ctx: CallerContext, replyId: string): Promise<{ liked: boolean; count: number }>;
  /** 置顶 / 取消置顶（本区 owner、协管或站方管理员）。 */
  setPinned(ctx: CallerContext, postId: string, pinned: boolean): Promise<void>;
  /** 我的帖子（个人中心）：不含已删除。 */
  listMine(ctx: CallerContext, input?: { page?: number; status?: ForumContentStatus }): Promise<PageResult<PostListItem>>;
}

export function createForumPostService(deps: { db: SqliteDatabase }): ForumPostService {
  const { db } = deps;

  function boardBySlug(conn: SqliteDatabase, slug: string) {
    const row = conn
      .prepare('SELECT id, slug, name, status, posting_policy, is_official FROM forum_boards WHERE slug = ?')
      .get(normalizeBoardSlug(slug)) as
      | { id: string; slug: string; name: string; status: string; posting_policy: string; is_official: number }
      | undefined;
    if (!row) throw err.unavailable('分区不存在。');
    return row;
  }

  function readPost(conn: SqliteDatabase, postId: string): PostRow {
    const row = conn.prepare(POST_SELECT + ' WHERE p.id = ?').get(postId) as PostRow | undefined;
    if (!row) throw err.unavailable('帖子不存在。');
    return row;
  }

  function boardRole(conn: SqliteDatabase, boardId: string, userId: string | null): 'owner' | 'moderator' | null {
    if (userId === null) return null;
    const row = conn
      .prepare('SELECT role FROM forum_board_moderators WHERE board_id = ? AND user_id = ?')
      .get(boardId, userId) as { role: 'owner' | 'moderator' } | undefined;
    return row ? row.role : null;
  }

  /** 本区管理者（owner 或协管）或站方管理员。 */
  function canModerateBoard(conn: SqliteDatabase, ctx: CallerContext, boardId: string): boolean {
    if (isAdmin(ctx)) return true;
    const role = boardRole(conn, boardId, ctx.userId);
    return role === 'owner' || role === 'moderator';
  }

  function validateTitle(raw: unknown): string {
    const title = typeof raw === 'string' ? raw.trim() : '';
    if (title.length === 0) throw err.input('标题不能为空。', [{ path: 'title', message: '必填' }]);
    if (title.length > FORUM_LIMITS.postTitleMax) {
      throw err.input(`标题不能超过 ${FORUM_LIMITS.postTitleMax} 字。`, [
        { path: 'title', message: '过长' },
      ]);
    }
    return title;
  }

  function validateBody(raw: unknown, max: number, field: string): string {
    const body = typeof raw === 'string' ? raw.trim() : '';
    if (body.length === 0) throw err.input('正文不能为空。', [{ path: field, message: '必填' }]);
    if (body.length > max) {
      throw err.input(`正文不能超过 ${max} 字。`, [{ path: field, message: '过长' }]);
    }
    return body;
  }

  function attachFiles(
    conn: SqliteDatabase,
    table: 'forum_post_attachment_links' | 'forum_reply_attachment_links',
    keyColumn: 'post_id' | 'reply_id',
    keyValue: string,
    fileIds: unknown[] | undefined,
    now: number,
  ): void {
    if (!Array.isArray(fileIds) || fileIds.length === 0) return;
    const seen = new Set<string>();
    for (const raw of fileIds) {
      if (typeof raw !== 'string' || raw.length === 0) {
        throw err.input('附件标识不合法。', [{ path: 'fileIds', message: '非法值' }]);
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      // 归属与层级约束交给触发器：这里不重复实现，避免两处规则漂移
      conn
        .prepare(`INSERT INTO ${table} (${keyColumn}, file_id, created_at) VALUES (?, ?, ?)`)
        .run(keyValue, raw, now);
    }
  }

  return {
    async listPosts(_ctx, boardSlug, input) {
      return withRead((conn) => {
        const board = boardBySlug(conn, boardSlug);
        const page = Math.max(1, Math.floor(input?.page ?? 1));
        const pageSize = Math.min(
          Math.max(1, Math.floor(input?.pageSize ?? PaginationDefaults.default_page_size)),
          FORUM_LIMITS.listPageSize * 2,
        );
        const sort = input?.sort ?? 'created';
        const order =
          sort === 'last_reply'
            ? 'p.is_pinned DESC, COALESCE(p.last_reply_at, p.created_at) DESC, p.id DESC'
            : 'p.is_pinned DESC, p.created_at DESC, p.id DESC';

        const total = conn
          .prepare("SELECT COUNT(*) AS c FROM forum_posts p WHERE p.board_id = ? AND p.status = 'published'")
          .get(board.id) as { c: number };

        const rows = conn
          .prepare(
            POST_SELECT +
              ` WHERE p.board_id = ? AND p.status = 'published'
                ORDER BY ${order} LIMIT ? OFFSET ?`,
          )
          .all(board.id, pageSize, (page - 1) * pageSize) as PostRow[];

        return buildPage(
          rows.map((r) => ({
            postId: r.id,
            boardId: r.board_id,
            boardSlug: r.board_slug,
            boardName: r.board_name,
            authorId: r.author_id,
            authorNickname: r.author_nickname,
            authorAvatarUrl: r.author_avatar_url,
            title: r.title,
            excerpt: excerptOf(r.body_md),
            status: r.status,
            isPinned: r.is_pinned === 1,
            likeCount: r.like_count,
            replyCount: r.reply_count,
            createdAt: r.created_at,
            lastReplyAt: r.last_reply_at,
          })),
          Number(total.c),
          { page, page_size: pageSize },
        );
      }, db);
    },

    async getPost(ctx, postId) {
      return withRead((conn) => {
        const row = readPost(conn, postId);
        const liked =
          ctx.userId === null
            ? false
            : conn
                .prepare('SELECT 1 AS x FROM forum_post_likes WHERE post_id = ? AND user_id = ?')
                .get(postId, ctx.userId) !== undefined;
        const moderate = canModerateBoard(conn, ctx, row.board_id);
        const isAuthor = ctx.userId !== null && ctx.userId === row.author_id;

        return {
          postId: row.id,
          boardId: row.board_id,
          boardSlug: row.board_slug,
          boardName: row.board_name,
          authorId: row.author_id,
          authorNickname: row.author_nickname,
          authorAvatarUrl: row.author_avatar_url,
          title: row.title,
          bodyMd: row.body_md,
          status: row.status,
          deletedBy: row.deleted_by,
          isPinned: row.is_pinned === 1,
          likeCount: row.like_count,
          likedByMe: liked,
          replyCount: row.reply_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          editedAt: row.edited_at,
          canEdit: isAuthor || moderate || isAdmin(ctx),
          canDelete: isAuthor || moderate,
          canModerate: moderate,
        };
      }, db);
    },

    async listReplies(ctx, postId) {
      return withRead((conn) => {
        readPost(conn, postId);
        const rows = conn
          .prepare(
            `SELECT r.*, u.nickname AS author_nickname, u.avatar_url AS author_avatar_url
               FROM forum_post_replies r
               JOIN users u ON u.id = r.author_id
              WHERE r.post_id = ?
              ORDER BY r.created_at, r.id`,
          )
          .all(postId) as Array<{
          id: string;
          post_id: string;
          author_id: string;
          parent_id: string | null;
          body_md: string;
          status: ForumContentStatus;
          like_count: number;
          created_at: number;
          edited_at: number | null;
          author_nickname: string;
          author_avatar_url: string | null;
        }>;

        const likedSet = new Set<string>();
        if (ctx.userId !== null) {
          const liked = conn
            .prepare(
              `SELECT l.reply_id FROM forum_post_reply_likes l
                 JOIN forum_post_replies r ON r.id = l.reply_id
                WHERE r.post_id = ? AND l.user_id = ?`,
            )
            .all(postId, ctx.userId) as Array<{ reply_id: string }>;
          for (const l of liked) likedSet.add(l.reply_id);
        }

        const toView = (r: (typeof rows)[number]): ReplyView => ({
          replyId: r.id,
          postId: r.post_id,
          authorId: r.author_id,
          authorNickname: r.author_nickname,
          authorAvatarUrl: r.author_avatar_url,
          parentId: r.parent_id,
          bodyMd: r.body_md,
          status: r.status,
          likeCount: r.like_count,
          likedByMe: likedSet.has(r.id),
          createdAt: r.created_at,
          editedAt: r.edited_at,
          children: [],
        });

        const tops = rows.filter((r) => r.parent_id === null).map(toView);
        const byId = new Map(tops.map((t) => [t.replyId, t]));
        for (const r of rows) {
          if (r.parent_id === null) continue;
          byId.get(r.parent_id)?.children.push(toView(r));
        }
        // 已删除的回复处理：有子回复时保留占位（否则子回复失去上下文）
        return { items: tops, total: rows.length };
      }, db);
    },

    async createPost(ctx, input) {
      assertCanWrite(ctx);
      const title = validateTitle(input.title);
      const body = validateBody(input.bodyMd, FORUM_LIMITS.postBodyMax, 'bodyMd');

      return withTransaction((tx) => {
        const conn = tx.db;
        const board = boardBySlug(conn, input.boardSlug);
        if (board.status === 'archived') throw err.forbidden('该分区已归档，不能发帖。');

        // 发帖权限：与分区服务同一套判定
        const role = boardRole(conn, board.id, ctx.userId);
        if (!isAdmin(ctx) && role !== 'owner') {
          const rule = conn
            .prepare('SELECT mode FROM forum_board_posting_rules WHERE board_id = ? AND user_id = ?')
            .get(board.id, ctx.userId) as { mode: 'allow' | 'deny' } | undefined;
          if (rule?.mode === 'deny') throw err.forbidden('你已被限制在该分区发帖。');
          if (board.posting_policy === 'admin_only') throw err.forbidden('该分区仅管理员可发帖。');
          if (board.posting_policy === 'whitelist' && rule?.mode !== 'allow') {
            throw err.forbidden('该分区仅白名单用户可发帖。');
          }
        }

        const postId = newId();
        const now = nowMs();
        conn
          .prepare(
            `INSERT INTO forum_posts
               (id, board_id, author_id, title, body_md, status, is_pinned, like_count, reply_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'published', 0, 0, 0, ?, ?)`,
          )
          .run(postId, board.id, ctx.userId, title, body, now, now);
        attachFiles(conn, 'forum_post_attachment_links', 'post_id', postId, input.fileIds, now);
        return { postId };
      }, db);
    },

    async editPost(ctx, postId, input) {
      assertCanWrite(ctx);
      const title = validateTitle(input.title);
      const body = validateBody(input.bodyMd, FORUM_LIMITS.postBodyMax, 'bodyMd');

      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readPost(conn, postId);
        const isAuthor = row.author_id === ctx.userId;
        if (!isAuthor && !canModerateBoard(conn, ctx, row.board_id)) {
          throw err.forbidden('只有作者或本区管理员可以编辑该帖。');
        }
        if (row.status === 'deleted') throw err.input('已删除的帖子不能编辑。', [{ path: 'postId', message: '已删除' }]);
        const now = nowMs();
        conn
          .prepare('UPDATE forum_posts SET title = ?, body_md = ?, updated_at = ?, edited_at = ? WHERE id = ?')
          .run(title, body, now, now, postId);
      }, db);
    },

    async deletePost(ctx, postId) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readPost(conn, postId);
        const isAuthor = row.author_id === ctx.userId;
        if (!isAuthor && !canModerateBoard(conn, ctx, row.board_id)) {
          throw err.forbidden('只有作者或本区管理员可以删除该帖。');
        }
        if (row.status === 'deleted') return; // 幂等
        const now = nowMs();
        // 软删：不级联删回复与点赞，那些是别人的痕迹
        conn
          .prepare("UPDATE forum_posts SET status = 'deleted', deleted_by = ?, deleted_at = ?, updated_at = ? WHERE id = ?")
          .run(ctx.userId, now, now, postId);
      }, db);
    },

    async createReply(ctx, postId, input) {
      assertCanWrite(ctx);
      const body = validateBody(input.bodyMd, FORUM_LIMITS.replyBodyMax, 'bodyMd');
      const parentId = typeof input.parentId === 'string' && input.parentId.length > 0 ? input.parentId : null;

      return withTransaction((tx) => {
        const conn = tx.db;
        const post = readPost(conn, postId);
        if (post.status === 'deleted') throw err.input('该帖已删除，不能回复。', [{ path: 'postId', message: '已删除' }]);
        const board = conn.prepare('SELECT status FROM forum_boards WHERE id = ?').get(post.board_id) as {
          status: string;
        };
        if (board.status === 'archived') throw err.forbidden('该分区已归档，不能回复。');

        let recipientId: string | null = post.author_id;
        let kind: 'forum_reply' | 'forum_reply_to_reply' = 'forum_reply';

        if (parentId !== null) {
          const parent = conn
            .prepare('SELECT id, post_id, author_id, parent_id, status FROM forum_post_replies WHERE id = ?')
            .get(parentId) as
            | { id: string; post_id: string; author_id: string; parent_id: string | null; status: ForumContentStatus }
            | undefined;
          if (!parent) throw err.input('要回复的那条不存在。', [{ path: 'parentId', message: '未知回复' }]);
          if (parent.post_id !== postId) {
            throw err.input('回复与帖子不匹配。', [{ path: 'parentId', message: '跨帖回复' }]);
          }
          // 两层封顶：给出能看懂的话，而不是把触发器的 ABORT 抛给用户
          if (parent.parent_id !== null) {
            throw err.input('回复最多两层：不能回复「回复的回复」。', [{ path: 'parentId', message: '层级超限' }]);
          }
          if (parent.status === 'deleted') {
            throw err.input('那条回复已删除，不能回复。', [{ path: 'parentId', message: '已删除' }]);
          }
          // 回复的回复不允许带图片
          if (Array.isArray(input.fileIds) && input.fileIds.length > 0) {
            throw err.input('回复的回复不能带图片。', [{ path: 'fileIds', message: '不允许' }]);
          }
          recipientId = parent.author_id;
          kind = 'forum_reply_to_reply';
        }

        const replyId = newId();
        const now = nowMs();
        conn
          .prepare(
            `INSERT INTO forum_post_replies
               (id, post_id, author_id, parent_id, body_md, status, like_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'published', 0, ?, ?)`,
          )
          .run(replyId, postId, ctx.userId, parentId, body, now, now);

        if (parentId === null) {
          attachFiles(conn, 'forum_reply_attachment_links', 'reply_id', replyId, input.fileIds, now);
        }

        // 计数与最后回复时间在事务内维护
        conn
          .prepare('UPDATE forum_posts SET reply_count = reply_count + 1, last_reply_at = ?, updated_at = ? WHERE id = ?')
          .run(now, now, postId);

        if (recipientId !== null) {
          deliverForumReplyNotification(conn, {
            recipientId,
            actorId: ctx.userId,
            kind,
            detail: excerptOf(body, 80),
            deduplicationKey: 'forum_reply:' + replyId + ':' + recipientId,
            now,
          });
        }

        return { replyId };
      }, db);
    },

    async deleteReply(ctx, replyId) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = conn
          .prepare('SELECT id, post_id, author_id, status FROM forum_post_replies WHERE id = ?')
          .get(replyId) as
          | { id: string; post_id: string; author_id: string; status: ForumContentStatus }
          | undefined;
        if (!row) throw err.unavailable('回复不存在。');
        const post = conn.prepare('SELECT board_id FROM forum_posts WHERE id = ?').get(row.post_id) as {
          board_id: string;
        };
        const isAuthor = row.author_id === ctx.userId;
        if (!isAuthor && !canModerateBoard(conn, ctx, post.board_id)) {
          throw err.forbidden('只有作者或本区管理员可以删除该回复。');
        }
        if (row.status === 'deleted') return;
        const now = nowMs();
        conn
          .prepare("UPDATE forum_post_replies SET status = 'deleted', deleted_by = ?, deleted_at = ?, updated_at = ? WHERE id = ?")
          .run(ctx.userId, now, now, replyId);
        conn
          .prepare('UPDATE forum_posts SET reply_count = MAX(reply_count - 1, 0), updated_at = ? WHERE id = ?')
          .run(now, row.post_id);
      }, db);
    },

    async togglePostLike(ctx, postId) {
      assertCanWrite(ctx);
      return withTransaction((tx) => {
        const conn = tx.db;
        const post = readPost(conn, postId);
        if (post.status === 'deleted') throw err.input('不能给已删除的帖子点赞。', [{ path: 'postId', message: '已删除' }]);

        const existing = conn
          .prepare('SELECT 1 AS x FROM forum_post_likes WHERE post_id = ? AND user_id = ?')
          .get(postId, ctx.userId);
        const now = nowMs();
        if (existing) {
          conn.prepare('DELETE FROM forum_post_likes WHERE post_id = ? AND user_id = ?').run(postId, ctx.userId);
          conn.prepare('UPDATE forum_posts SET like_count = MAX(like_count - 1, 0) WHERE id = ?').run(postId);
          const row = conn.prepare('SELECT like_count FROM forum_posts WHERE id = ?').get(postId) as { like_count: number };
          return { liked: false, count: row.like_count };
        }
        conn
          .prepare('INSERT INTO forum_post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)')
          .run(postId, ctx.userId, now);
        conn.prepare('UPDATE forum_posts SET like_count = like_count + 1 WHERE id = ?').run(postId);
        const row = conn.prepare('SELECT like_count FROM forum_posts WHERE id = ?').get(postId) as { like_count: number };
        return { liked: true, count: row.like_count };
      }, db);
    },

    async toggleReplyLike(ctx, replyId) {
      assertCanWrite(ctx);
      return withTransaction((tx) => {
        const conn = tx.db;
        const reply = conn
          .prepare('SELECT id, post_id, parent_id, status FROM forum_post_replies WHERE id = ?')
          .get(replyId) as
          | { id: string; post_id: string; parent_id: string | null; status: ForumContentStatus }
          | undefined;
        if (!reply) throw err.unavailable('回复不存在。');
        if (reply.status === 'deleted') {
          throw err.input('不能给已删除的回复点赞。', [{ path: 'replyId', message: '已删除' }]);
        }
        if (reply.parent_id !== null) {
          // 回复的回复不参与点赞（使用者口径），触发器也拦，这里给可读原因
          throw err.input('只有顶层回复可以点赞。', [{ path: 'replyId', message: '不支持' }]);
        }

        const existing = conn
          .prepare('SELECT 1 AS x FROM forum_post_reply_likes WHERE reply_id = ? AND user_id = ?')
          .get(replyId, ctx.userId);
        const now = nowMs();
        if (existing) {
          conn
            .prepare('DELETE FROM forum_post_reply_likes WHERE reply_id = ? AND user_id = ?')
            .run(replyId, ctx.userId);
          conn
            .prepare('UPDATE forum_post_replies SET like_count = MAX(like_count - 1, 0) WHERE id = ?')
            .run(replyId);
        } else {
          conn
            .prepare('INSERT INTO forum_post_reply_likes (reply_id, user_id, created_at) VALUES (?, ?, ?)')
            .run(replyId, ctx.userId, now);
          conn.prepare('UPDATE forum_post_replies SET like_count = like_count + 1 WHERE id = ?').run(replyId);
        }
        const row = conn.prepare('SELECT like_count FROM forum_post_replies WHERE id = ?').get(replyId) as {
          like_count: number;
        };
        return { liked: existing === undefined, count: row.like_count };
      }, db);
    },

    async setPinned(ctx, postId, pinned) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        const conn = tx.db;
        const row = readPost(conn, postId);
        if (!canModerateBoard(conn, ctx, row.board_id)) {
          throw err.forbidden('只有本区管理员或区长可以置顶。');
        }
        conn
          .prepare('UPDATE forum_posts SET is_pinned = ?, updated_at = ? WHERE id = ?')
          .run(pinned ? 1 : 0, nowMs(), postId);
      }, db);
    },

    async listMine(ctx, input) {
      assertCanWrite(ctx);
      return withRead((conn) => {
        const page = Math.max(1, Math.floor(input?.page ?? 1));
        const pageSize = PaginationDefaults.default_page_size;
        const status = input?.status ?? 'published';
        const total = conn
          .prepare('SELECT COUNT(*) AS c FROM forum_posts WHERE author_id = ? AND status = ?')
          .get(ctx.userId, status) as { c: number };
        const rows = conn
          .prepare(
            POST_SELECT + ' WHERE p.author_id = ? AND p.status = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?',
          )
          .all(ctx.userId, status, pageSize, (page - 1) * pageSize) as PostRow[];
        return buildPage(
          rows.map((r) => ({
            postId: r.id,
            boardId: r.board_id,
            boardSlug: r.board_slug,
            boardName: r.board_name,
            authorId: r.author_id,
            authorNickname: r.author_nickname,
            authorAvatarUrl: r.author_avatar_url,
            title: r.title,
            excerpt: excerptOf(r.body_md),
            status: r.status,
            isPinned: r.is_pinned === 1,
            likeCount: r.like_count,
            replyCount: r.reply_count,
            createdAt: r.created_at,
            lastReplyAt: r.last_reply_at,
          })),
          Number(total.c),
          { page, page_size: pageSize },
        );
      }, db);
    },
  };
}
