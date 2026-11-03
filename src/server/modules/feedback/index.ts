/**
 * 问题反馈（迁移 0036，设计见 docs/项目规划/设计-问题反馈.md）。
 *
 * 三条边界：
 *   1. **纯私有**：只有提交者本人与管理员能看到；没有 visibility 字段，也没有对外页面；
 *   2. **状态变化必须留痕**：任何一次处理都写一条 feedback_handling_records（含理由），
 *      票上的 status 只是这份记录的投影，审计以记录为准；
 *   3. **去重按「同一人 + 同一类型 + 同一页面」24 小时**：重复提交返回已有票，不新建。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { isAdmin, type CallerContext } from '@/server/platform/context';
import { recordOperationInTx } from '@/server/modules/operations';
import { deliverFeedbackResultNotification } from '@/server/modules/notifications';
import { buildPage, type PageResult } from '@/packages/common/result';

export {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_ACTIONS,
  FEEDBACK_ACTION_LABELS,
  FEEDBACK_LIMITS,
} from '@/packages/common/feedback';
export type { FeedbackKind, FeedbackStatus, FeedbackAction } from '@/packages/common/feedback';

import {
  FEEDBACK_KINDS,
  FEEDBACK_ACTIONS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_LIMITS,
  type FeedbackKind,
  type FeedbackStatus,
  type FeedbackAction,
} from '@/packages/common/feedback';

const ACTION_TO_STATUS: Record<FeedbackAction, FeedbackStatus> = {
  acknowledge: 'acknowledged',
  fix: 'fixed',
  duplicate: 'duplicate',
  wontfix: 'wontfix',
  unreproducible: 'unreproducible',
  reopen: 'acknowledged',
};

const TERMINAL: readonly FeedbackStatus[] = ['fixed', 'duplicate', 'wontfix', 'unreproducible'];

export interface FeedbackTicketView {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  pageUrl: string | null;
  pageKind: string | null;
  objectId: string | null;
  status: FeedbackStatus;
  duplicateOf: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** 仅管理员视图填充。 */
  submittedBy?: { userId: string; nickname: string | null };
  contextJson?: string | null;
  records?: FeedbackRecordView[];
}

export interface FeedbackRecordView {
  id: string;
  action: FeedbackAction;
  reason: string;
  replyText: string | null;
  handledBy: { userId: string; nickname: string | null };
  createdAt: number;
}

interface TicketRow {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  page_url: string | null;
  page_kind: string | null;
  object_id: string | null;
  context_json: string | null;
  status: FeedbackStatus;
  duplicate_of: string | null;
  submitted_by: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/** 由站内路径推断页面类型：只认前缀，不猜语义。 */
function inferPageKind(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  if (pageUrl === '/plugins' || pageUrl.startsWith('/plugins/')) return 'plugin';
  if (pageUrl === '/reviews' || pageUrl.startsWith('/reviews/')) return 'review';
  if (pageUrl === '/packs' || pageUrl.startsWith('/packs/')) return 'pack';
  if (pageUrl.startsWith('/plugins?')) return 'search';
  return 'other';
}

/** 从 /plugins/{id} 这类路径里取对象 id（取不到就不填，不做模糊匹配）。 */
function inferObjectId(pageUrl: string | null, pageKind: string | null): string | null {
  if (!pageUrl) return null;
  const path = pageUrl.split('?')[0];
  const match = /^\/(plugins|reviews|packs)\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (!match) return null;
  if (pageKind === null) return null;
  return match[2];
}

function readTicket(db: SqliteDatabase, ticketId: string): TicketRow {
  const row = db
    .prepare(
      'SELECT id, kind, title, body, page_url, page_kind, object_id, context_json, status, duplicate_of, ' +
        'submitted_by, created_at, updated_at, closed_at FROM feedback_tickets WHERE id = ?',
    )
    .get(ticketId) as TicketRow | undefined;
  if (!row) throw err.unavailable('这条反馈不存在。');
  return row;
}

function toView(row: TicketRow): FeedbackTicketView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    pageUrl: row.page_url,
    pageKind: row.page_kind,
    objectId: row.object_id,
    status: row.status,
    duplicateOf: row.duplicate_of,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedAt: row.closed_at,
  };
}

function assertAdmin(ctx: CallerContext, message: string): string {
  if (!isAdmin(ctx) || !ctx.userId) throw err.forbidden(message);
  return ctx.userId;
}

export function createFeedbackService(deps: { db: SqliteDatabase }) {
  const db = deps.db;

  return {
    /**
     * 提交一张票。
     *
     * 返回 `created=false` 表示命中 24 小时去重（调用方应退还限流额度，与举报接口同一口径）。
     */
    async createTicket(
      ctx: CallerContext,
      input: {
        kind: unknown;
        title: unknown;
        body: unknown;
        pageUrl?: unknown;
        contextJson?: unknown;
      },
    ): Promise<{ ticketId: string; created: boolean }> {
      if (ctx.userId === null) throw err.unauthenticated();
      if (!FEEDBACK_KINDS.includes(input.kind as FeedbackKind)) {
        throw err.input('反馈类型不合法。', [{ path: 'kind', message: FEEDBACK_KINDS.join(' / ') }]);
      }
      const kind = input.kind as FeedbackKind;

      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (title.length === 0 || title.length > FEEDBACK_LIMITS.titleMax) {
        throw err.input('标题需 1-' + FEEDBACK_LIMITS.titleMax + ' 字。', [{ path: 'title', message: '必填' }]);
      }
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (body.length === 0 || body.length > FEEDBACK_LIMITS.bodyMax) {
        throw err.input('详细描述需 1-' + FEEDBACK_LIMITS.bodyMax + ' 字。', [{ path: 'body', message: '必填' }]);
      }

      const rawPageUrl = typeof input.pageUrl === 'string' ? input.pageUrl.trim() : '';
      if (rawPageUrl.length > FEEDBACK_LIMITS.pageUrlMax) {
        throw err.input('页面地址过长。', [{ path: 'pageUrl', message: '不超过 1000 字' }]);
      }
      if (rawPageUrl.length > 0 && (!rawPageUrl.startsWith('/') || rawPageUrl.startsWith('//'))) {
        throw err.input('页面地址必须是站内路径（以 / 开头）。', [{ path: 'pageUrl', message: '站内路径' }]);
      }
      const pageUrl = rawPageUrl.length === 0 ? null : rawPageUrl;
      const pageKind = inferPageKind(pageUrl);
      const objectId = inferObjectId(pageUrl, pageKind);

      let contextJson: string | null = null;
      if (typeof input.contextJson === 'string' && input.contextJson.trim().length > 0) {
        if (input.contextJson.length > FEEDBACK_LIMITS.contextMax) {
          throw err.input('环境信息过长。', [{ path: 'contextJson', message: '不超过 2000 字' }]);
        }
        contextJson = input.contextJson;
      }

      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const now = nowMs();

        // 24 小时去重：同一人 + 同一类型 + 同一页面，仍存在的票直接复用。
        const since = now - FEEDBACK_LIMITS.dedupeWindowMs;
        const existing = conn
          .prepare(
            'SELECT id FROM feedback_tickets WHERE submitted_by = ? AND kind = ? ' +
              'AND COALESCE(page_url, \'\') = COALESCE(?, \'\') AND created_at >= ? ' +
              'ORDER BY created_at DESC LIMIT 1',
          )
          .get(userId, kind, pageUrl, since) as { id: string } | undefined;
        if (existing) return { ticketId: existing.id, created: false };

        const ticketId = newId(now);
        conn
          .prepare(
            'INSERT INTO feedback_tickets ' +
              '(id, kind, title, body, page_url, page_kind, object_id, context_json, status, duplicate_of, ' +
              'submitted_by, created_at, updated_at, closed_at) ' +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, NULL)",
          )
          .run(
            ticketId,
            kind,
            title,
            body,
            pageUrl,
            pageKind,
            objectId,
            contextJson,
            userId,
            now,
            now,
          );

        recordOperationInTx(
          conn,
          {
            actionType: 'feedback.create',
            operationKey: 'feedback_create:' + ticketId,
            actorKind: 'user',
            actorUserId: userId,
            targetType: 'feedback_ticket',
            targetId: ticketId,
            targetSnapshot: { kind, title, pageUrl },
            changes: { status: 'open' },
            reason: '用户提交问题反馈',
          },
          now,
        );

        return { ticketId, created: true };
      }, db);
    },

    /** 我的反馈列表（倒序分页）。 */
    async listMine(
      ctx: CallerContext,
      req: { page?: number; pageSize?: number } = {},
    ): Promise<PageResult<FeedbackTicketView>> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      const page = Math.max(1, Math.floor(req.page ?? 1));
      const pageSize = Math.min(50, Math.max(1, Math.floor(req.pageSize ?? 20)));
      return withRead((conn) => {
        const total = Number(
          (conn.prepare('SELECT COUNT(*) AS c FROM feedback_tickets WHERE submitted_by = ?').get(userId) as {
            c: number;
          }).c,
        );
        const rows = conn
          .prepare(
            'SELECT id, kind, title, body, page_url, page_kind, object_id, context_json, status, duplicate_of, ' +
              'submitted_by, created_at, updated_at, closed_at FROM feedback_tickets ' +
              'WHERE submitted_by = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
          )
          .all(userId, pageSize, (page - 1) * pageSize) as TicketRow[];
        return buildPage(rows.map(toView), total, { page, page_size: pageSize });
      }, db);
    },

    /** 我的单条反馈（越权一律 404，不泄露存在性）。 */
    async getMine(ctx: CallerContext, ticketId: string): Promise<FeedbackTicketView> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const row = conn
          .prepare('SELECT submitted_by FROM feedback_tickets WHERE id = ?')
          .get(ticketId) as { submitted_by: string } | undefined;
        if (!row || row.submitted_by !== userId) throw err.unavailable('这条反馈不存在。');
        const ticket = toView(readTicket(conn, ticketId));
        ticket.records = readRecords(conn, ticketId);
        return ticket;
      }, db);
    },

    /** 管理员：队列（默认只看待处理）。 */
    async listQueue(
      ctx: CallerContext,
      req: { status?: FeedbackStatus | 'all'; kind?: FeedbackKind | 'all'; page?: number; pageSize?: number } = {},
    ): Promise<PageResult<FeedbackTicketView>> {
      assertAdmin(ctx, '只有管理员可以查看反馈队列。');
      const page = Math.max(1, Math.floor(req.page ?? 1));
      const pageSize = Math.min(50, Math.max(1, Math.floor(req.pageSize ?? 20)));
      const status = req.status && req.status !== 'all' ? req.status : null;
      const kind = req.kind && req.kind !== 'all' ? req.kind : null;

      return withRead((conn) => {
        const where: string[] = [];
        const params: unknown[] = [];
        if (status) {
          where.push('t.status = ?');
          params.push(status);
        }
        if (kind) {
          where.push('t.kind = ?');
          params.push(kind);
        }
        const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
        const total = Number(
          (conn.prepare('SELECT COUNT(*) AS c FROM feedback_tickets t' + whereSql).get(...params) as { c: number }).c,
        );
        const rows = conn
          .prepare(
            'SELECT t.id, t.kind, t.title, t.body, t.page_url, t.page_kind, t.object_id, t.context_json, ' +
              't.status, t.duplicate_of, t.submitted_by, t.created_at, t.updated_at, t.closed_at, ' +
              'u.nickname AS submitter_nickname FROM feedback_tickets t ' +
              'JOIN users u ON u.id = t.submitted_by' +
              whereSql +
              ' ORDER BY t.created_at ASC, t.id ASC LIMIT ? OFFSET ?',
          )
          .all(...params, pageSize, (page - 1) * pageSize) as Array<TicketRow & { submitter_nickname: string | null }>;
        return buildPage(
          rows.map((row) => {
            const view = toView(row);
            view.submittedBy = { userId: row.submitted_by, nickname: row.submitter_nickname };
            view.contextJson = row.context_json;
            return view;
          }),
          total,
          { page, page_size: pageSize },
        );
      }, db);
    },

    /** 管理员：单条详情（含处理历史）。 */
    async getForAdmin(ctx: CallerContext, ticketId: string): Promise<FeedbackTicketView> {
      assertAdmin(ctx, '只有管理员可以查看反馈详情。');
      return withRead((conn) => {
        const ticket = toView(readTicket(conn, ticketId));
        const owner = conn
          .prepare('SELECT u.id, u.nickname FROM users u JOIN feedback_tickets t ON t.submitted_by = u.id WHERE t.id = ?')
          .get(ticketId) as { id: string; nickname: string | null } | undefined;
        ticket.submittedBy = owner ? { userId: owner.id, nickname: owner.nickname } : undefined;
        ticket.contextJson = readTicket(conn, ticketId).context_json;
        ticket.records = readRecords(conn, ticketId);
        return ticket;
      }, db);
    },

    /**
     * 管理员处理：改状态 + 留痕 + 通知提交人。
     *
     * `reopen` 是唯一允许从终态回到 `acknowledged` 的动作；其余动作在终态上一律拒绝。
     */
    async handle(
      ctx: CallerContext,
      ticketId: string,
      input: { action: unknown; reason: unknown; replyText?: unknown; duplicateOf?: unknown },
    ): Promise<{ status: FeedbackStatus; notified: boolean }> {
      const adminId = assertAdmin(ctx, '只有管理员可以处理反馈。');
      if (!FEEDBACK_ACTIONS.includes(input.action as FeedbackAction)) {
        throw err.input('处理动作不合法。', [{ path: 'action', message: FEEDBACK_ACTIONS.join(' / ') }]);
      }
      const action = input.action as FeedbackAction;
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length === 0 || reason.length > FEEDBACK_LIMITS.reasonMax) {
        throw err.input('处理必须写明理由（1-' + FEEDBACK_LIMITS.reasonMax + ' 字）。', [
          { path: 'reason', message: '必填' },
        ]);
      }
      const replyRaw = typeof input.replyText === 'string' ? input.replyText.trim() : '';
      if (replyRaw.length > FEEDBACK_LIMITS.replyMax) {
        throw err.input('回复过长。', [{ path: 'replyText', message: '不超过 2000 字' }]);
      }
      const replyText = replyRaw.length === 0 ? null : replyRaw;

      const duplicateOf =
        action === 'duplicate' && typeof input.duplicateOf === 'string' ? input.duplicateOf.trim() : null;
      if (action === 'duplicate' && (duplicateOf === null || duplicateOf.length === 0)) {
        throw err.input('标记重复时必须指出是哪一条。', [{ path: 'duplicateOf', message: '必填' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const ticket = readTicket(conn, ticketId);
        const isTerminal = TERMINAL.includes(ticket.status);
        if (isTerminal && action !== 'reopen') {
          throw err.conflict('这条反馈已经是终态，如需重新打开请用「重新打开」。', { status: ticket.status });
        }
        if (!isTerminal && action === 'reopen') {
          throw err.conflict('这条反馈还在处理中，不需要重新打开。', { status: ticket.status });
        }

        if (duplicateOf !== null) {
          if (duplicateOf === ticketId) {
            throw err.input('不能把一条反馈标成它自己的重复。', [{ path: 'duplicateOf', message: '不能自指' }]);
          }
          const target = conn.prepare('SELECT id FROM feedback_tickets WHERE id = ?').get(duplicateOf) as
            | { id: string }
            | undefined;
          if (!target) {
            throw err.input('所指的反馈不存在。', [{ path: 'duplicateOf', message: '未知票' }]);
          }
          // 成环保护：沿目标票的 duplicate_of 链走，最多 20 跳
          let cursor: string | null = duplicateOf;
          for (let hop = 0; hop < 20 && cursor !== null; hop += 1) {
            if (cursor === ticketId) {
              throw err.input('这会形成重复环。', [{ path: 'duplicateOf', message: '成环' }]);
            }
            const next = conn.prepare('SELECT duplicate_of FROM feedback_tickets WHERE id = ?').get(cursor) as
              | { duplicate_of: string | null }
              | undefined;
            cursor = next?.duplicate_of ?? null;
          }
        }

        const nextStatus = ACTION_TO_STATUS[action];
        const now = nowMs();
        const closedAt = TERMINAL.includes(nextStatus) ? now : null;
        conn
          .prepare(
            'UPDATE feedback_tickets SET status = ?, duplicate_of = ?, closed_at = ?, updated_at = ? WHERE id = ?',
          )
          .run(nextStatus, duplicateOf, closedAt, now, ticketId);

        const recordId = newId(now);
        conn
          .prepare(
            'INSERT INTO feedback_handling_records (id, ticket_id, handled_by, action, reason, reply_text, notified, created_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
          )
          .run(recordId, ticketId, adminId, action, reason, replyText, now);

        recordOperationInTx(
          conn,
          {
            actionType: 'feedback.handle',
            operationKey: 'feedback_handle:' + recordId,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'feedback_ticket',
            targetId: ticketId,
            targetSnapshot: { status: ticket.status },
            changes: { status: nextStatus, action },
            reason,
          },
          now,
        );

        // 通知提交人：正文用给用户的回复；没写回复就用内部理由（至少让人知道结果）
        const detail = FEEDBACK_STATUS_LABELS[nextStatus] + '：' + (replyText ?? reason);
        const delivered = deliverFeedbackResultNotification(conn, {
          recipientId: ticket.submitted_by,
          actorId: adminId,
          detail,
          linkUrl: '/feedback/' + ticketId,
          deduplicationKey: 'feedback:' + ticketId + ':' + recordId,
          now,
        });
        if (delivered.created) {
          conn.prepare('UPDATE feedback_handling_records SET notified = 1 WHERE id = ?').run(recordId);
        }

        return { status: nextStatus, notified: delivered.created };
      }, db);
    },
  };
}

export type FeedbackService = ReturnType<typeof createFeedbackService>;

function readRecords(db: SqliteDatabase, ticketId: string): FeedbackRecordView[] {
  const rows = db
    .prepare(
      'SELECT r.id, r.action, r.reason, r.reply_text, r.created_at, u.id AS handled_by, u.nickname ' +
        'FROM feedback_handling_records r JOIN users u ON u.id = r.handled_by ' +
        'WHERE r.ticket_id = ? ORDER BY r.created_at ASC, r.id ASC',
    )
    .all(ticketId) as Array<{
    id: string;
    action: FeedbackAction;
    reason: string;
    reply_text: string | null;
    created_at: number;
    handled_by: string;
    nickname: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    reason: row.reason,
    replyText: row.reply_text,
    handledBy: { userId: row.handled_by, nickname: row.nickname },
    createdAt: Number(row.created_at),
  }));
}
