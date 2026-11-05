/**
 * 讨论区 · 发帖草稿。
 *
 * 形态（设计文档 §3.6）：
 *   * 草稿独立成表 forum_post_drafts，不进 forum_posts——草稿不需要置顶/计数/审核态，
 *     混进同一张表会让每条列表查询都得记得排除它，漏一处就把没写完的东西泄漏出去。
 *   * 草稿允许标题或正文为空（写一半很正常），**发布时才校验**标题与正文。
 *   * 发布是一次性动作：把草稿内容搬进 forum_posts（走与直接发帖同一套权限、
 *     自动审核、附件规则），成功后删掉草稿。失败则草稿原样留着，用户不必重打。
 *   * 每条草稿只能被作者本人读写：非作者一律"不存在"，不区分"没有"与"不是你的"。
 */

import { assertCanWrite, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { FORUM_LIMITS } from '@/packages/common/forum';
import { resolveAttachmentFileIds } from './attachments';

export interface DraftView {
  draftId: string;
  boardId: string;
  boardSlug: string;
  boardName: string;
  title: string;
  bodyMd: string;
  fileIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface DraftRow {
  id: string;
  author_id: string;
  board_id: string;
  title: string;
  body_md: string;
  created_at: number;
  updated_at: number;
  board_slug: string;
  board_name: string;
}

const DRAFT_SELECT = `SELECT d.*, b.slug AS board_slug, b.name AS board_name
   FROM forum_post_drafts d
   JOIN forum_boards b ON b.id = d.board_id`;

function readDraft(conn: SqliteDatabase, draftId: string, authorId: string): DraftRow {
  const row = conn
    .prepare(`${DRAFT_SELECT} WHERE d.id = ? AND d.author_id = ?`)
    .get(draftId, authorId) as DraftRow | undefined;
  // 别人的草稿与不存在的草稿给同一个答案，避免"这个 id 存在"被探测出来
  if (!row) throw err.input('草稿不存在。', [{ path: 'draftId', message: '未找到' }]);
  return row;
}

function filesOf(conn: SqliteDatabase, draftId: string): string[] {
  const rows = conn
    .prepare('SELECT file_id FROM forum_post_draft_attachment_links WHERE draft_id = ? ORDER BY created_at, file_id')
    .all(draftId) as Array<{ file_id: string }>;
  return rows.map((r) => r.file_id);
}

function toView(conn: SqliteDatabase, row: DraftRow): DraftView {
  return {
    draftId: row.id,
    boardId: row.board_id,
    boardSlug: row.board_slug,
    boardName: row.board_name,
    title: row.title,
    bodyMd: row.body_md,
    fileIds: filesOf(conn, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampText(raw: unknown, max: number, field = 'bodyMd'): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (text.length > max) {
    throw err.input(`内容不能超过 ${max} 字。`, [{ path: field, message: '过长' }]);
  }
  return text;
}

function readBoard(conn: SqliteDatabase, boardId: string): { id: string; status: string } {
  const board = conn.prepare('SELECT id, status FROM forum_boards WHERE id = ?').get(boardId) as
    | { id: string; status: string }
    | undefined;
  if (!board) throw err.input('分区不存在。', [{ path: 'boardId', message: '未找到' }]);
  return board;
}

/**
 * 替换草稿的附件引用。
 *
 * 传入的是「附件 id」（上传控件拿到的 attachments.id）或 attachment_files.id，
 * 这里统一解析成文件 id 再落库——与发帖/回复同一套口径（见 ./attachments）。
 * 归属约束仍由 trg_forum_draft_attachment_owner_insert 兜底。
 */
function replaceFiles(
  conn: SqliteDatabase,
  draftId: string,
  ownerId: string,
  raw: unknown,
  now: number,
): void {
  conn.prepare('DELETE FROM forum_post_draft_attachment_links WHERE draft_id = ?').run(draftId);
  const fileIds = resolveAttachmentFileIds(conn, { raw, ownerId, field: 'attachmentIds' });
  if (fileIds.length > FORUM_LIMITS.postAttachmentsMax) {
    throw err.input(`最多只能带 ${FORUM_LIMITS.postAttachmentsMax} 张图片，当前 ${fileIds.length} 张。`, [
      { path: 'attachmentIds', message: 'too_many' },
    ]);
  }
  for (const fileId of fileIds) {
    conn
      .prepare('INSERT INTO forum_post_draft_attachment_links (draft_id, file_id, created_at) VALUES (?, ?, ?)')
      .run(draftId, fileId, now);
  }
}

/**
 * 在**调用方的事务里**删掉一条草稿（含附件链接）。
 *
 * 发布草稿要把"建帖"与"删草稿"放进同一个事务：分成两次提交的话，
 * 帖子已经写进去、删草稿失败，用户看到报错后重试就会发出**第二篇一模一样的帖子**。
 * 事务内一起回滚，重试才是安全的。
 */
export function deleteDraftInTx(conn: SqliteDatabase, draftId: string, authorId: string): void {
  readDraft(conn, draftId, authorId);
  conn.prepare('DELETE FROM forum_post_draft_attachment_links WHERE draft_id = ?').run(draftId);
  conn.prepare('DELETE FROM forum_post_drafts WHERE id = ?').run(draftId);
}

export function createForumDraftService({ db }: { db: SqliteDatabase }) {
  return {
    /** 列表：只列本人的草稿，按最近改动排序。 */
    async listMine(ctx: CallerContext) {
      assertCanWrite(ctx);
      return withRead((conn) => {
        const rows = conn
          .prepare(`${DRAFT_SELECT} WHERE d.author_id = ? ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`)
          .all(ctx.userId, FORUM_LIMITS.draftMax) as DraftRow[];
        // total 必须是**真实条数**而不是返回到手的行数：saveDraft 在上限处会拒收新草稿，
        // 提示语要说出"你在 100 条里有多少"，total 谎报成 100 就又成了一处假状态。
        const counted = conn
          .prepare('SELECT COUNT(*) AS c FROM forum_post_drafts WHERE author_id = ?')
          .get(ctx.userId) as { c: number };
        return { items: rows.map((r) => toView(conn, r)), total: Number(counted.c) };
      }, db);
    },

    async getDraft(ctx: CallerContext, draftId: string) {
      assertCanWrite(ctx);
      return withRead((conn) => toView(conn, readDraft(conn, draftId, ctx.userId ?? '')), db);
    },

    /**
     * 保存草稿。draftId 为空则新建。
     * 标题与正文都允许为空——写一半关掉页面是正常操作。
     */
    async saveDraft(
      ctx: CallerContext,
      input: {
        draftId?: string;
        boardId?: string;
        title?: string;
        bodyMd?: string;
        /** 正文图片：attachments.id 或 attachment_files.id 均可（写入前统一解析）。 */
        attachmentIds?: unknown;
        /** @deprecated 旧字段名，等价于 attachmentIds。 */
        fileIds?: unknown;
      },
    ) {
      assertCanWrite(ctx);
      // 两个字段名等价；attachmentIds 是正名。
      const rawFiles = input.attachmentIds !== undefined ? input.attachmentIds : input.fileIds;
      return withTransaction((tx) => {
        const conn = tx.db;
        const now = nowMs();
        const draftId = typeof input.draftId === 'string' && input.draftId.length > 0 ? input.draftId : null;

        if (draftId !== null) {
          const row = readDraft(conn, draftId, ctx.userId ?? '');
          // **部分更新**：只有真的出现在请求体里的字段才写。
          // 此前缺字段被当成空串，于是自动保存只带 bodyMd 的那次请求会把标题清空、
          // 把附件链接全删——用户眼看着标题和图片凭空消失。
          const boardId = typeof input.boardId === 'string' && input.boardId.length > 0 ? input.boardId : row.board_id;
          readBoard(conn, boardId);
          const title = input.title === undefined ? row.title : clampText(input.title, FORUM_LIMITS.postTitleMax, 'title');
          const body =
            input.bodyMd === undefined ? row.body_md : clampText(input.bodyMd, FORUM_LIMITS.postBodyMax, 'bodyMd');
          conn
            .prepare('UPDATE forum_post_drafts SET board_id = ?, title = ?, body_md = ?, updated_at = ? WHERE id = ?')
            .run(boardId, title, body, now, draftId);
          // 同理：请求里没有附件字段时不动附件表，否则"只改标题"会把图删光。
          if (rawFiles !== undefined) replaceFiles(conn, draftId, ctx.userId, rawFiles, now);
          return { draftId, created: false };
        }

        const title = clampText(input.title, FORUM_LIMITS.postTitleMax, 'title');
        const body = clampText(input.bodyMd, FORUM_LIMITS.postBodyMax, 'bodyMd');
        const boardId = typeof input.boardId === 'string' ? input.boardId : '';
        if (boardId.length === 0) {
          throw err.input('请先选择分区。', [{ path: 'boardId', message: '必填' }]);
        }
        readBoard(conn, boardId);
        // 每人封顶（PR-讨论区.md「已知取舍」第 3 条）。判在同一个写事务里，
        // 并发新建也超不过上限；更新已有草稿不受影响。
        const counted = conn
          .prepare('SELECT COUNT(*) AS c FROM forum_post_drafts WHERE author_id = ?')
          .get(ctx.userId) as { c: number };
        if (Number(counted.c) >= FORUM_LIMITS.draftMax) {
          throw err.input(`草稿最多 ${FORUM_LIMITS.draftMax} 条，请先删除不用的草稿再新建。`, [
            { path: 'draftId', message: '已达上限' },
          ]);
        }
        const id = newId();
        conn
          .prepare(
            `INSERT INTO forum_post_drafts (id, author_id, board_id, title, body_md, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, ctx.userId, boardId, title, body, now, now);
        replaceFiles(conn, id, ctx.userId, rawFiles, now);
        return { draftId: id, created: true };
      }, db);
    },

    async deleteDraft(ctx: CallerContext, draftId: string) {
      assertCanWrite(ctx);
      await withTransaction((tx) => {
        deleteDraftInTx(tx.db, draftId, ctx.userId ?? '');
      }, db);
    },

  };
}
