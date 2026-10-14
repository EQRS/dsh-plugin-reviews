/**
 * 站内通知（`idea.md §11`）。
 *
 * 规划要求逐条对应到这里：
 *   * **新评论通知内容作者；回复通知被回复人** → `resolveRecipient()`
 *   * **公开后才发** → 投递点在 `publishComment` 的事务里（那一刻评论才公开）
 *   * **自己不通知自己** → 应用层判一次 + 数据库 `CHECK (recipient_id <> actor_id)` 再兜一次
 *   * **同一事件不重复** → `UNIQUE (deduplication_key)`（键按**评论**而不是修订，编辑不再通知）
 *   * **顶部未读数** → `countUnread()`；已读用 `markRead()`（天然幂等，不必再要请求键）
 *
 * 刻意**不存在**的一层：`business_events` / `event_delivery_tasks`（架构里为可重试扇出准备的）。
 * 本切片只发站内一条记录，投递与发布同事务，不需要投递队列；要加邮件/webhook 时再补，
 * 现在建三张空表只会多三张"有表无事"。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { newId } from '@/server/platform/id';

export type NotificationKind = 'comment_on_content' | 'reply_to_comment';

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  commentId: string;
  contentEntityId: string;
  /** 触发者展示信息（头像缺失时为 null，页面据此回退到文字）。 */
  actorNickname: string;
  actorAvatarUrl: string | null;
  /** 评论正文摘要（已编辑的评论取当前修订）。 */
  excerpt: string;
  readAt: number | null;
  createdAt: number;
}

export interface DeliverResult {
  created: boolean;
  /** created=false 时的原因，便于日志与测试断言。 */
  reason: 'self' | 'duplicate' | 'recipient_missing' | null;
  recipientId: string | null;
}

/** 摘要长度：列表里一行够用，不把整条评论塞进通知。 */
const EXCERPT_MAX = 80;

/**
 * 解析收件人：回复 → 被回复评论的作者；顶层评论 → 内容实体作者。
 * 找不到（内容/被回复评论已不在）时返回 null，调用方按"无收件人"处理（不报错）。
 */
function resolveRecipient(
  db: SqliteDatabase,
  input: { contentEntityId: string; replyToCommentId: string | null },
): string | null {
  if (input.replyToCommentId !== null) {
    const row = db
      .prepare('SELECT author_id FROM comments WHERE id = ?')
      .get(input.replyToCommentId) as { author_id: string } | undefined;
    return row?.author_id ?? null;
  }
  const row = db
    .prepare('SELECT author_id FROM content_entities WHERE id = ?')
    .get(input.contentEntityId) as { author_id: string } | undefined;
  return row?.author_id ?? null;
}

/**
 * 投递一条评论通知（**在发布事务内**调用）。
 *
 * 返回而不是抛错：通知发不出去不该让"评论已经公开"这件事回滚 —— 唯一会抛的是
 * 数据库约束（那是真 bug），其余情况如实报告原因。
 */
export function deliverCommentNotification(
  db: SqliteDatabase,
  input: {
    commentId: string;
    contentEntityId: string;
    actorId: string;
    replyToCommentId: string | null;
    now: number;
  },
): DeliverResult {
  const recipientId = resolveRecipient(db, {
    contentEntityId: input.contentEntityId,
    replyToCommentId: input.replyToCommentId,
  });
  if (recipientId === null) return { created: false, reason: 'recipient_missing', recipientId: null };
  // 自己不通知自己（数据库还有 CHECK 兜底，这里先判是为了不去撞约束）
  if (recipientId === input.actorId) return { created: false, reason: 'self', recipientId };

  const kind: NotificationKind = input.replyToCommentId === null ? 'comment_on_content' : 'reply_to_comment';
  // 键按**评论**而非修订：编辑评论换新修订，但那不是"新评论"，不再通知一次。
  const deduplicationKey = `comment_published:${input.commentId}:${recipientId}`;

  const inserted = db
    .prepare(
      `INSERT INTO notifications
         (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (deduplication_key) DO NOTHING`,
    )
    .run(
      newId(input.now),
      recipientId,
      kind,
      input.actorId,
      input.commentId,
      input.contentEntityId,
      deduplicationKey,
      input.now,
    );

  if (inserted.changes === 0) return { created: false, reason: 'duplicate', recipientId };
  return { created: true, reason: null, recipientId };
}

export interface NotificationsService {
  list(
    userId: string,
    req: { limit?: number; unreadOnly?: boolean },
  ): Promise<{ items: NotificationView[]; unreadCount: number }>;
  countUnread(userId: string): Promise<number>;
  markRead(userId: string, input: { ids?: string[]; all?: boolean }): Promise<{ marked: number }>;
}

export function createNotificationsService(deps: { db: SqliteDatabase }): NotificationsService {
  const { db } = deps;

  /** 未读数与列表共用的可见性：只看自己的，不做跨用户读取。 */
  function countUnreadFor(userId: string): number {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND read_at IS NULL')
      .get(userId) as { c: number };
    return row.c;
  }

  return {
    async countUnread(userId) {
      return countUnreadFor(userId);
    },

    async list(userId, req) {
      const limit = Math.min(Math.max(req.limit ?? 20, 1), 50);
      const unreadOnly = req.unreadOnly === true;
      const rows = db
        .prepare(
          `SELECT n.id, n.kind, n.comment_id, n.content_entity_id, n.read_at, n.created_at,
                  u.nickname AS actor_nickname, u.avatar_url AS actor_avatar_url,
                  rev.body AS body
             FROM notifications n
             JOIN users u ON u.id = n.actor_id
             LEFT JOIN comments c ON c.id = n.comment_id
             LEFT JOIN comment_revisions rev ON rev.id = c.published_revision_id
            WHERE n.recipient_id = ?
              ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
            ORDER BY n.created_at DESC, n.id DESC
            LIMIT ?`,
        )
        .all(userId, limit) as Array<{
        id: string;
        kind: NotificationKind;
        comment_id: string;
        content_entity_id: string;
        read_at: number | null;
        created_at: number;
        actor_nickname: string;
        actor_avatar_url: string | null;
        body: string | null;
      }>;

      return {
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          commentId: r.comment_id,
          contentEntityId: r.content_entity_id,
          actorNickname: r.actor_nickname,
          actorAvatarUrl: r.actor_avatar_url,
          excerpt: (r.body ?? '（评论已删除）').slice(0, EXCERPT_MAX),
          readAt: r.read_at,
          createdAt: r.created_at,
        })),
        unreadCount: countUnreadFor(userId),
      };
    },

    async markRead(userId, input) {
      const now = Date.now();
      if (input.all === true) {
        const res = db
          .prepare('UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL')
          .run(now, userId);
        return { marked: res.changes };
      }
      const ids = (input.ids ?? []).filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) return { marked: 0 };
      // 逐条 UPDATE：`WHERE recipient_id = ?` 保证**只能标记自己的**通知（越权在 SQL 层就挡住）。
      const stmt = db.prepare(
        'UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL',
      );
      let marked = 0;
      const run = db.transaction(() => {
        for (const id of ids) marked += stmt.run(now, id, userId).changes;
      });
      run();
      return { marked };
    },
  };
}
