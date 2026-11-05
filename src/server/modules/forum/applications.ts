/**
 * 讨论区 · 分区申请与审核。
 *
 * 流程（设计文档 §3.3）：
 *   用户提交申请（名称/slug/描述/理由）→ 管理员在后台审 → 通过时建分区、
 *   申请人自动成为 owner、写审计、发通知。
 *
 * 几条刻意的取舍：
 *   * **只有站方管理员能审**：分区是站点的门面，不能让"想当区长的人"互相批。
 *   * 通过时 slug 要与现有分区、以及其它待审申请去重：宽松审会撞出两个同名分区，
 *     而 slug 进 URL，改起来会断链。
 *   * 拒绝也要写理由（reviewNote）：申请人有权知道为什么不行。
 *   * 同一人同一 slug 只能有一份待审申请（迁移里的部分唯一索引兜底），
 *     被拒后可以再申请。
 */

import { assertCanAdmin, assertCanWrite, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import type { PageResult } from '@/packages/common/result';
import { buildPage, PaginationDefaults } from '@/packages/common/result';
import {
  BOARD_SLUG_PATTERN,
  FORUM_LIMITS,
  normalizeBoardSlug,
  type BoardApplicationStatus,
} from '@/packages/common/forum';
import { deliverModerationResultNotification } from '@/server/modules/notifications';

export interface BoardApplicationView {
  applicationId: string;
  applicantId: string;
  applicantNickname: string;
  name: string;
  slug: string;
  description: string;
  reason: string;
  status: BoardApplicationStatus;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

export interface ForumBoardApplicationService {
  submit(ctx: CallerContext, input: unknown): Promise<{ applicationId: string }>;
  listMine(ctx: CallerContext): Promise<BoardApplicationView[]>;
  listQueue(ctx: CallerContext, input?: { status?: BoardApplicationStatus; page?: number }): Promise<PageResult<BoardApplicationView>>;
  /** 通过：建分区 + 申请人成为 owner + 通知。 */
  approve(ctx: CallerContext, applicationId: string, note?: unknown): Promise<{ boardId: string }>;
  reject(ctx: CallerContext, applicationId: string, note: unknown): Promise<void>;
}

const SELECT = `
  SELECT a.*, u.nickname AS applicant_nickname
    FROM forum_board_applications a
    JOIN users u ON u.id = a.applicant_id
`;

interface AppRow {
  id: string;
  applicant_id: string;
  applicant_nickname: string;
  name: string;
  slug: string;
  description: string;
  reason: string;
  status: BoardApplicationStatus;
  reviewer_id: string | null;
  review_note: string | null;
  created_at: number;
  reviewed_at: number | null;
}

function toView(r: AppRow): BoardApplicationView {
  return {
    applicationId: r.id,
    applicantId: r.applicant_id,
    applicantNickname: r.applicant_nickname,
    name: r.name,
    slug: r.slug,
    description: r.description,
    reason: r.reason,
    status: r.status,
    reviewerId: r.reviewer_id,
    reviewNote: r.review_note,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

function readString(raw: unknown, field: string, max: number, required: boolean): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (required && value.length === 0) {
    throw err.input('这一项不能为空。', [{ path: field, message: '必填' }]);
  }
  if (value.length > max) {
    throw err.input(`不能超过 ${max} 字。`, [{ path: field, message: '过长' }]);
  }
  return value;
}

export function createForumBoardApplicationService(deps: {
  db: SqliteDatabase;
}): ForumBoardApplicationService {
  const { db } = deps;

  function readApplication(conn: SqliteDatabase, id: string): AppRow {
    const row = conn.prepare(SELECT + ' WHERE a.id = ?').get(id) as AppRow | undefined;
    if (!row) throw err.unavailable('申请不存在。');
    return row;
  }

  return {
    async submit(ctx, input) {
      assertCanWrite(ctx);
      const payload = (input ?? {}) as Record<string, unknown>;
      const name = readString(payload.name, 'name', FORUM_LIMITS.boardNameMax, true);
      const slug = normalizeBoardSlug(payload.slug);
      const description = readString(payload.description, 'description', FORUM_LIMITS.boardDescriptionMax, false);
      const reason = readString(payload.reason, 'reason', FORUM_LIMITS.applicationReasonMax, true);

      if (!BOARD_SLUG_PATTERN.test(slug)) {
        throw err.input('标识只能用英文小写字母、数字与连字符。', [{ path: 'slug', message: '格式不合法' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const clash = conn.prepare('SELECT 1 AS x FROM forum_boards WHERE slug = ?').get(slug);
        if (clash) {
          throw err.input('这个标识已被现有分区占用。', [{ path: 'slug', message: '已被占用' }]);
        }
        const pending = conn
          .prepare("SELECT 1 AS x FROM forum_board_applications WHERE slug = ? AND status = 'pending'")
          .get(slug);
        if (pending) {
          throw err.input('这个标识已有待审申请。', [{ path: 'slug', message: '待审中' }]);
        }

        const id = newId();
        const now = nowMs();
        conn
          .prepare(
            `INSERT INTO forum_board_applications
               (id, applicant_id, name, slug, description, reason, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(id, ctx.userId, name, slug, description, reason, now);
        return { applicationId: id };
      }, db);
    },

    async listMine(ctx) {
      assertCanWrite(ctx);
      return withRead((conn) => {
        const rows = conn
          .prepare(SELECT + ' WHERE a.applicant_id = ? ORDER BY a.created_at DESC, a.id DESC')
          .all(ctx.userId) as AppRow[];
        return rows.map(toView);
      }, db);
    },

    async listQueue(ctx, input) {
      assertCanAdmin(ctx);
      return withRead((conn) => {
        const page = Math.max(1, Math.floor(input?.page ?? 1));
        const pageSize = PaginationDefaults.default_page_size;
        const status = input?.status ?? 'pending';
        const total = conn
          .prepare('SELECT COUNT(*) AS c FROM forum_board_applications WHERE status = ?')
          .get(status) as { c: number };
        const rows = conn
          .prepare(SELECT + ' WHERE a.status = ? ORDER BY a.created_at, a.id LIMIT ? OFFSET ?')
          .all(status, pageSize, (page - 1) * pageSize) as AppRow[];
        return buildPage(rows.map(toView), Number(total.c), { page, page_size: pageSize });
      }, db);
    },

    async approve(ctx, applicationId, note) {
      assertCanAdmin(ctx);
      const noteText = readString(note, 'note', 1000, false);
      return withTransaction((tx) => {
        const conn = tx.db;
        const app = readApplication(conn, applicationId);
        if (app.status !== 'pending') {
          throw err.input('该申请已经处理过了。', [{ path: 'applicationId', message: '非待审' }]);
        }
        // 再次校验 slug：排队期间可能被别人抢先建了
        const clash = conn.prepare('SELECT id FROM forum_boards WHERE slug = ?').get(app.slug) as
          | { id: string }
          | undefined;
        if (clash) {
          throw err.input('这个标识已被现有分区占用，请让申请人换个标识。', [
            { path: 'slug', message: '已被占用' },
          ]);
        }

        const now = nowMs();
        const boardId = newId();
        conn
          .prepare(
            `INSERT INTO forum_boards
               (id, slug, name, description, posting_policy, is_official, status, owner_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'everyone', 0, 'active', ?, ?, ?, ?)`,
          )
          .run(boardId, app.slug, app.name, app.description, app.applicant_id, ctx.userId, now, now);

        conn
          .prepare(
            `INSERT INTO forum_board_moderators (board_id, user_id, role, granted_by, created_at)
             VALUES (?, ?, 'owner', ?, ?)`,
          )
          .run(boardId, app.applicant_id, ctx.userId, now);

        conn
          .prepare(
            `UPDATE forum_board_applications
                SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = ?
              WHERE id = ?`,
          )
          .run(ctx.userId, noteText.length > 0 ? noteText : null, now, applicationId);

        deliverModerationResultNotification(conn, {
          recipientId: app.applicant_id,
          actorId: ctx.userId,
          contentEntityId: null,
          // 走分区申请自己的 kind（迁移 0037 已建这类），不再冒充 moderation_result
          kind: 'forum_board_application',
          detail: '分区「' + app.name + '」已通过审核，你可以开始发帖了。' + (noteText ? '附言：' + noteText : ''),
          deduplicationKey: 'forum_board_application:' + applicationId + ':' + app.applicant_id,
          now,
        });

        return { boardId };
      }, db);
    },

    async reject(ctx, applicationId, note) {
      assertCanAdmin(ctx);
      const noteText = readString(note, 'note', 1000, true); // 拒绝必须写理由
      await withTransaction((tx) => {
        const conn = tx.db;
        const app = readApplication(conn, applicationId);
        if (app.status !== 'pending') {
          throw err.input('该申请已经处理过了。', [{ path: 'applicationId', message: '非待审' }]);
        }
        const now = nowMs();
        conn
          .prepare(
            `UPDATE forum_board_applications
                SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = ?
              WHERE id = ?`,
          )
          .run(ctx.userId, noteText, now, applicationId);

        deliverModerationResultNotification(conn, {
          recipientId: app.applicant_id,
          actorId: ctx.userId,
          contentEntityId: null,
          kind: 'forum_board_application',
          detail: '分区申请「' + app.name + '」未通过：' + noteText,
          deduplicationKey: 'forum_board_application:' + applicationId + ':' + app.applicant_id,
          now,
        });
      }, db);
    },
  };
}
