/**
 * 评论模块（工作包 GC · 签名见 已删除的设计稿《模块签名契约》 第 5 节）。
 *
 * 盖楼规则（已删除的设计稿《并行工作包》 不变量 8 / 架构第 79.1 节）：
 *   回复时 `root` = 被回复者是顶层则取自身，否则取其 `root_comment_id`；
 *   创建后不可改（触发器 `trg_comments_fixed_relations` 已强制）。
 *
 * 同一事务内建立：comments + comment_revisions（不可变快照）+ content_submissions（提交）+ 检查任务。
 * 任务入队走 GT 的 tasks 模块签名（`@/server/modules/tasks`）。
 */

import { assertCanWrite, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import { digest } from '@/server/platform/digest';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import type { PageRequest, PageResult } from '@/packages/common/result';
import { buildPage, PaginationDefaults } from '@/packages/common/result';
import { isUuidV7, type SubmissionState } from '@/packages/common/field-rules';

// ============================================================
// 视图与输入
// ============================================================

export interface CommentView {
  commentId: string;
  contentEntityId: string;
  authorId: string;
  body: string;
  replyToCommentId: string | null;
  rootCommentId: string | null;
  publishedRevisionId: string | null;
  latestSubmittedRevisionId: string | null;
  createdAt: number;
  firstPublishedAt: number | null;
  editedAt: number | null;
  deletedAt: number | null;
  /** 顶层评论的回复数（组内回复计数）；回复自身为 0。 */
  replyCount: number;
}

export interface CreateCommentResult {
  commentId: string;
  revisionId: string;
  submissionId: string;
  /**
   * false = 命中**同作者同 requestKey 的幂等重放**（返回既有提交，没有新建任何东西）。
   *
   * 之前实现里已经在返回这个字段，但契约里漏声明了 —— 现在明确写进来，因为调用方需要它：
   * 频控要求"重放不另算一次提交"，路由据此决定要不要退还额度（见
   * `src/server/platform/rate-limit.ts` 的 ticket.refund）。
   */
  created: boolean;
}

/** 评论正文上限：与架构第 79 节的正文长度上限保持一致（超出即拒绝，不静默截断）。 */
export const COMMENT_BODY_MAX_LENGTH = 20_000;

/** 评论提交的检查任务调度组（同一篇内容下的评论检查串行，避免打爆外部服务）。 */
export const COMMENT_CHECK_SCHEDULING_GROUP = 'comment_check';

/** 评论提交初始状态：等待检查，绝不视为已通过。 */
export const COMMENT_SUBMISSION_INITIAL_STATE: SubmissionState = 'pending';

interface CommentRow {
  id: string;
  content_entity_id: string;
  author_id: string;
  reply_to_comment_id: string | null;
  root_comment_id: string | null;
  published_revision_id: string | null;
  latest_submitted_revision_id: string | null;
  created_at: number;
  first_published_at: number | null;
  edited_at: number | null;
  deleted_at: number | null;
}

// ============================================================
// 校验
// ============================================================

/** 写入前置：登录 + 账户正常。走平台统一实现，保证与接口层的错误码映射一致。 */
function requireActiveUser(ctx: CallerContext): string {
  assertCanWrite(ctx);
  return ctx.userId;
}

function parseEntityId(contentEntityId: string): string {
  if (typeof contentEntityId !== 'string' || !isUuidV7(contentEntityId)) {
    throw err.input('内容标识格式不正确。', [{ path: 'content_entity_id', message: '必须是规范 UUIDv7' }]);
  }
  return contentEntityId;
}

function parseBody(body: string): string {
  if (typeof body !== 'string') {
    throw err.input('评论正文必须是文本。', [{ path: 'body', message: '类型不正确' }]);
  }
  if (body.trim().length === 0) {
    throw err.input('评论正文不能为空。', [{ path: 'body', message: '必填' }]);
  }
  if ([...body].length > COMMENT_BODY_MAX_LENGTH) {
    throw err.input('评论正文超过长度上限。', [
      { path: 'body', message: `不得超过 ${COMMENT_BODY_MAX_LENGTH} 个字符` },
    ]);
  }
  return body;
}

function parseRequestKey(requestKey: string): string {
  if (typeof requestKey !== 'string' || requestKey.trim().length === 0) {
    throw err.input('请求标识不能为空。', [{ path: 'request_key', message: '必填' }]);
  }
  return requestKey;
}

/** 评论标识：与内容标识同一套规范（UUIDv7），格式不对就是输入错误，不做静默兜底。 */
function parseCommentId(commentId: string): string {
  if (typeof commentId !== 'string' || !isUuidV7(commentId)) {
    throw err.input('评论标识格式不正确。', [{ path: 'comment_id', message: '必须是规范 UUIDv7' }]);
  }
  return commentId;
}

function normalizePageRequest(req: PageRequest): PageRequest {
  const page = Number.isInteger(req?.page) && req.page > 0 ? req.page : 1;
  const size = Number.isInteger(req?.page_size) && req.page_size > 0 ? req.page_size : PaginationDefaults.default_page_size;
  return { page, page_size: Math.min(size, PaginationDefaults.max_page_size) };
}

function toView(row: CommentRow, body: string, replyCount: number): CommentView {
  return {
    commentId: row.id,
    contentEntityId: row.content_entity_id,
    authorId: row.author_id,
    // 已删除的评论**不留正文**（占位靠 deletedAt 非空表达，页面显示"该评论已被作者删除"）。
    // 这是删除功能的前提：删除只是标记，如果这里照样把 body 读出来，删除等于没删。
    body: row.deleted_at !== null ? '' : body,
    replyToCommentId: row.reply_to_comment_id,
    rootCommentId: row.root_comment_id,
    publishedRevisionId: row.published_revision_id,
    latestSubmittedRevisionId: row.latest_submitted_revision_id,
    createdAt: row.created_at,
    firstPublishedAt: row.first_published_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    replyCount,
  };
}

function readCommentRow(db: SqliteDatabase, commentId: string): CommentRow {
  const row = db
    .prepare(
      `SELECT id, content_entity_id, author_id, reply_to_comment_id, root_comment_id,
              published_revision_id, latest_submitted_revision_id,
              created_at, first_published_at, edited_at, deleted_at
       FROM comments WHERE id = ?`,
    )
    .get(commentId) as CommentRow | undefined;
  if (!row) throw err.unavailable('评论不存在或已不可访问。');
  return row;
}

/** 未发布评论没有修订可读；已发布的读**公开修订**，不是最新提交修订。 */
function readBody(db: SqliteDatabase, row: CommentRow): string {
  // 已删除：不读任何修订（哪怕它还留着 published_revision_id）。
  if (row.deleted_at !== null) return '';
  if (row.published_revision_id) {
    const rev = db
      .prepare('SELECT body FROM comment_revisions WHERE id = ? AND comment_id = ?')
      .get(row.published_revision_id, row.id) as { body: string } | undefined;
    if (rev) return rev.body;
  }
  // 尚无公开修订（评论待检查）：退回最新提交修订，保证作者能看到自己刚写的内容。
  if (row.latest_submitted_revision_id) {
    const rev = db
      .prepare('SELECT body FROM comment_revisions WHERE id = ? AND comment_id = ?')
      .get(row.latest_submitted_revision_id, row.id) as { body: string } | undefined;
    if (rev) return rev.body;
  }
  const latest = db
    .prepare('SELECT body FROM comment_revisions WHERE comment_id = ? ORDER BY revision_number DESC LIMIT 1')
    .get(row.id) as { body: string } | undefined;
  return latest?.body ?? '';
}

/**
 * 组内回复数（不含顶层自身）。
 *
 * 只统计**已公开**回复：未公开的新回复不能因为"数字上去了"而泄露存在
 * （架构第 79.2 节：公开回复数量只统计允许展示正文的回复）。
 */
function countReplies(db: SqliteDatabase, rootCommentId: string): number {
  return (
    // 已删除的回复不计数：它的正文不展示，计数里带着它会让"回复数"和看得见的条数对不上。
    db
      .prepare(
        `SELECT count(*) AS c FROM comments
          WHERE root_comment_id = ? AND published_revision_id IS NOT NULL AND deleted_at IS NULL`,
      )
      .get(rootCommentId) as { c: number }
  ).c;
}

// ============================================================
// 任务入队：按 GT 契约调用，模块尚未就绪时**降级但不假装成功**
// ============================================================

type EnqueueFn = (input: {
  taskType: 'review_check' | 'review_publish' | 'comment_check' | 'comment_publish';
  deduplicationKey: string;
  requestedBy: string | null;
  payload: unknown;
  schedulingGroup: string;
  availableAt: number;
  tx?: unknown;
}) => Promise<{ taskId: string; created: boolean }>;

/**
 * 懒加载 tasks 模块。
 *
 * 关键纪律：tasks 属于 GT 桶，本模块**不得**自己插 background_tasks 冒充实现。
 * 若该模块尚未落地，这里返回 null，调用方据此跳过入队，
 * 让提交停在 `pending`（任务缺失时人工与恢复扫描能发现），
 * **绝不能**因为任务没建成就把提交当成已检查通过。
 *
 * 导入路径与导出形状以 GT 的实际实现为准：`@/server/modules/tasks/service` 导出的是
 * **工厂** `createTasksService(db)` 与进程级单例访问器 `tasksService()`
 * （注意 `tasksService` 是函数、不是服务对象本身）。
 * 这里优先用 `createTasksService(db)`：显式传连接才能保证与评论同库。
 */
interface TasksModule {
  createTasksService?: (db: SqliteDatabase) => { enqueue?: EnqueueFn };
  tasksService?: () => { enqueue?: EnqueueFn };
}

let cachedTasksModule: TasksModule | null | undefined;

async function loadTasksModule(): Promise<TasksModule | null> {
  if (cachedTasksModule !== undefined) return cachedTasksModule;
  try {
    cachedTasksModule = (await import('@/server/modules/tasks/service')) as TasksModule;
  } catch {
    cachedTasksModule = null;
  }
  return cachedTasksModule;
}

/**
 * 取到 enqueue 函数。必须绑定到**同一连接**：
 * 评论提交已在自身事务里落地，入队若落到另一条连接，
 * 会写出指向别处数据库的任务 —— 看起来成功、实际对不上。
 */
async function loadEnqueue(db: SqliteDatabase): Promise<EnqueueFn | null> {
  const mod = await loadTasksModule();
  if (!mod) return null;
  if (typeof mod.createTasksService === 'function') {
    return mod.createTasksService(db).enqueue ?? null;
  }
  // 兜底：只暴露单例访问器时退回单例（生产环境 Web 与 worker 同库）。
  if (typeof mod.tasksService === 'function') {
    return mod.tasksService().enqueue ?? null;
  }
  return null;
}

// ============================================================
// 服务实现
// ============================================================

export const commentsService = {
  /**
   * 创建顶层评论或回复。
   *
   * 幂等：`content_submissions` 上有 `UNIQUE (submitted_by, request_key)`，
   * 同一作者用同一 requestKey 重复提交必须**返回原结果**，而不是造出第二条评论。
   */
  async createComment(
    ctx: CallerContext,
    input: {
      contentEntityId: string;
      body: string;
      replyToCommentId?: string | null;
      requestKey: string;
    },
    injectedDb?: SqliteDatabase,
  ): Promise<CreateCommentResult> {
    const userId = requireActiveUser(ctx);
    const contentEntityId = parseEntityId(input.contentEntityId);
    const body = parseBody(input.body);
    const requestKey = parseRequestKey(input.requestKey);
    const replyToCommentId = input.replyToCommentId ?? null;

    if (replyToCommentId !== null) {
      if (typeof replyToCommentId !== 'string' || !isUuidV7(replyToCommentId)) {
        throw err.input('被回复评论标识格式不正确。', [{ path: 'reply_to_comment_id', message: '必须是规范 UUIDv7' }]);
      }
    }

    // 任务入队在事务外先解析引用（动态 import 不能出现在同步事务里）。
    // 连接选择与业务写入一致：注入了测试库就用测试库，否则用平台默认连接。
    let enqueue: EnqueueFn | null = null;
    if (injectedDb) {
      enqueue = await loadEnqueue(injectedDb);
    } else {
      const { getDb } = await import('@/server/platform/db');
      enqueue = await loadEnqueue(getDb());
    }

    const result = withTransaction((tx) => {
      const db = tx.db;
      // 幂等优先：同一作者同一 requestKey 必须复用既有提交（不新建评论）。
      const existingSubmission = db
        .prepare(
          `SELECT s.id AS submission_id, s.request_digest AS request_digest,
                  s.comment_revision_id AS comment_revision_id, rev.comment_id AS comment_id
           FROM content_submissions s
           LEFT JOIN comment_revisions rev ON rev.id = s.comment_revision_id
           WHERE s.submitted_by = ? AND s.request_key = ?`,
        )
        .get(userId, requestKey) as
        | { submission_id: string; request_digest: string; comment_revision_id: string | null; comment_id: string | null }
        | undefined;

      if (existingSubmission) {
        const requestDigest = digestCommentRequest(contentEntityId, body, replyToCommentId);
        if (existingSubmission.request_digest !== requestDigest) throw err.keyReused();
        if (!existingSubmission.comment_revision_id || !existingSubmission.comment_id) {
          throw err.internal('既有评论提交缺少快照关联。');
        }
        return {
          commentId: existingSubmission.comment_id,
          revisionId: existingSubmission.comment_revision_id,
          submissionId: existingSubmission.submission_id,
          created: false,
        };
      }

      // 目标内容必须存在。
      const entity = db
        .prepare('SELECT id, author_id, withdrawn_at, hidden_at FROM content_entities WHERE id = ?')
        .get(contentEntityId) as { id: string; withdrawn_at: number | null; hidden_at: number | null } | undefined;
      if (!entity) throw err.unavailable('内容不存在或已不可访问。');

      let rootCommentId: string | null = null;
      if (replyToCommentId !== null) {
        const target = db
          .prepare(
            `SELECT id, content_entity_id, reply_to_comment_id, root_comment_id
             FROM comments WHERE id = ?`,
          )
          .get(replyToCommentId) as
          | { id: string; content_entity_id: string; reply_to_comment_id: string | null; root_comment_id: string | null }
          | undefined;

        // 被回复对象不存在，或不属于同一公共内容 → 拒绝（不泄露另一对象的讨论内容）。
        if (!target || target.content_entity_id !== contentEntityId) {
          throw err.unavailable('被回复的评论不存在或不属于该内容。');
        }

        // root 解析：被回复者是顶层则取自身，否则取其 root_comment_id。
        // 这里显式算出来再写入，而不是留给触发器去猜——触发器只是兜底。
        rootCommentId = target.reply_to_comment_id === null ? target.id : target.root_comment_id;
        if (rootCommentId === null) throw err.internal('盖楼归属解析失败：回复缺少顶层归属。');
      }

      const commentId = newId();
      const revisionId = newId();
      const submissionId = newId();
      const now = nowMs();

      // 1) 评论本体：顶层两列全空，回复两列非空且指向已解析的 root。
      db.prepare(
        `INSERT INTO comments
           (id, content_entity_id, author_id, reply_to_comment_id, root_comment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(commentId, contentEntityId, userId, replyToCommentId, rootCommentId, now);

      // 2) 不可变快照：修订号取该评论当前最大 + 1。
      db.prepare(
        `INSERT INTO comment_revisions (id, comment_id, revision_number, body, submitted_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).run(revisionId, commentId, body, now);

      // 3) 提交：进入待检查，绝不直接视为通过。
      //    评论提交不关联草稿（CHECK 要求 draft_id / draft_save_version 均为空）。
      db.prepare(
        `INSERT INTO content_submissions
           (id, submitted_by, submission_type, comment_revision_id, request_key, request_digest,
            processing_state, state_version, publication_context, submitted_at, updated_at)
         VALUES (?, ?, 'comment_revision', ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        submissionId,
        userId,
        revisionId,
        requestKey,
        digestCommentRequest(contentEntityId, body, replyToCommentId),
        COMMENT_SUBMISSION_INITIAL_STATE,
        JSON.stringify({ contentEntityId, commentId, rootCommentId, replyToCommentId }),
        now,
        now,
      );

      return { commentId, revisionId, submissionId, created: true };
    }, injectedDb);

    // 4) 检查任务：与业务提交同属一次请求，但入队本身走 tasks 模块（GT 桶）。
    //    事务已提交后再入队；入队失败不改变“评论已创建”的事实，但**必须**让调用方看见，
    //    所以这里把错误向上抛，由接口层决定重试——不静默吞掉。
    if (result.created && enqueue) {
      await enqueue({
        taskType: 'comment_check',
        // 去重键绑定提交：同一提交重复入队必须复用同一任务（表上有 UNIQUE(task_type, deduplication_key)）。
        deduplicationKey: `comment_check:${result.submissionId}`,
        requestedBy: userId,
        payload: { submissionId: result.submissionId, commentId: result.commentId, contentEntityId },
        schedulingGroup: COMMENT_CHECK_SCHEDULING_GROUP,
        availableAt: nowMs(),
        tx: undefined,
      });
    }

    // ⚠️ 必须把 created 透传出去：丢掉它会让调用方无法区分"新建"与"幂等重放"，
    // 频控的"重放退还额度"就会静默失效（这个字段以前在这里被漏掉了，tsc 报出来后才发现）。
    return {
      commentId: result.commentId,
      revisionId: result.revisionId,
      submissionId: result.submissionId,
      created: result.created,
    };
  },

  /**
   * 修改自己的评论（`idea.md §11`：同套检查后替换公开内容、页面显示"已编辑"）。
   *
   * 三件事必须**一起**做，否则会踩 `publishComment` 里写明的那两个坑：
   *  1. 新建修订（revision_number = 该评论当前最大 + 1，快照不可变）；
   *  2. 新建提交走**同一套检查**（绝不直接替换公开内容 —— 改后的正文没查过就上线是漏洞）；
   *  3. 维护 `comments.latest_submitted_revision_id`，让发布侧能判"旧修订已被新修订取代"。
   *     只加发布侧的 superseded 检查而不维护这一列，会让**所有**评论永远发不出去（曾经写错过一次）。
   *
   * 编辑**不重新发通知**（去重键按评论而不是修订，见 notifications 模块）。
   */
  async editComment(
    ctx: CallerContext,
    input: { commentId: string; body: string; requestKey: string },
    injectedDb?: SqliteDatabase,
  ): Promise<CreateCommentResult & { contentEntityId: string }> {
    const userId = requireActiveUser(ctx);
    const commentId = parseCommentId(input.commentId);
    const body = parseBody(input.body);
    const requestKey = parseRequestKey(input.requestKey);

    let enqueue: EnqueueFn | null = null;
    if (injectedDb) {
      enqueue = await loadEnqueue(injectedDb);
    } else {
      const { getDb } = await import('@/server/platform/db');
      enqueue = await loadEnqueue(getDb());
    }

    const result = withTransaction((tx) => {
      const db = tx.db;
      const comment = readCommentRow(db, commentId);

      // 幂等优先（与新建同构）：同作者同 requestKey 复用既有提交，不新建修订。
      const existing = db
        .prepare(
          `SELECT s.id AS submission_id, s.request_digest AS request_digest,
                  s.comment_revision_id AS comment_revision_id, rev.comment_id AS comment_id
             FROM content_submissions s
             LEFT JOIN comment_revisions rev ON rev.id = s.comment_revision_id
            WHERE s.submitted_by = ? AND s.request_key = ?`,
        )
        .get(userId, requestKey) as
        | { submission_id: string; request_digest: string; comment_revision_id: string | null; comment_id: string | null }
        | undefined;

      if (existing) {
        if (existing.request_digest !== digestCommentEditRequest(commentId, body)) throw err.keyReused();
        if (!existing.comment_revision_id || !existing.comment_id) {
          throw err.internal('既有修改提交缺少快照关联。');
        }
        return {
          commentId: existing.comment_id,
          revisionId: existing.comment_revision_id,
          submissionId: existing.submission_id,
          created: false,
          contentEntityId: comment.content_entity_id,
        };
      }

      // 权限与状态（都在事务内重新核验，不依赖调用方此前的判断）
      if (comment.author_id !== userId) throw err.forbidden('只能修改自己发布的评论。');
      if (comment.deleted_at !== null) throw err.unavailable('评论已删除，不能再修改。');

      const now = nowMs();
      const revisionId = newId();
      const submissionId = newId();
      const nextNumber =
        (
          db
            .prepare('SELECT COALESCE(MAX(revision_number), 0) AS n FROM comment_revisions WHERE comment_id = ?')
            .get(commentId) as { n: number }
        ).n + 1;

      db.prepare(
        `INSERT INTO comment_revisions (id, comment_id, revision_number, body, submitted_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(revisionId, commentId, nextNumber, body, now);

      db.prepare(
        `INSERT INTO content_submissions
           (id, submitted_by, submission_type, comment_revision_id, request_key, request_digest,
            processing_state, state_version, publication_context, submitted_at, updated_at)
         VALUES (?, ?, 'comment_revision', ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        submissionId,
        userId,
        revisionId,
        requestKey,
        digestCommentEditRequest(commentId, body),
        COMMENT_SUBMISSION_INITIAL_STATE,
        JSON.stringify({
          contentEntityId: comment.content_entity_id,
          commentId,
          rootCommentId: comment.root_comment_id,
          replyToCommentId: comment.reply_to_comment_id,
          edit: true,
        }),
        now,
        now,
      );

      // 关键的一列：发布侧的"被更新提交取代"检查靠它（见本方法注释第 3 条）。
      db.prepare('UPDATE comments SET latest_submitted_revision_id = ? WHERE id = ?').run(revisionId, commentId);

      return {
        commentId,
        revisionId,
        submissionId,
        created: true,
        contentEntityId: comment.content_entity_id,
      };
    }, injectedDb);

    if (result.created && enqueue) {
      await enqueue({
        taskType: 'comment_check',
        deduplicationKey: `comment_check:${result.submissionId}`,
        requestedBy: userId,
        payload: {
          submissionId: result.submissionId,
          commentId: result.commentId,
          contentEntityId: result.contentEntityId,
        },
        schedulingGroup: COMMENT_CHECK_SCHEDULING_GROUP,
        availableAt: nowMs(),
        tx: undefined,
      });
    }

    return result;
  },

  /**
   * 删除自己的评论（`idea.md §11`）。
   *
   * **软删除**（写 `deleted_at`），不是物理删：讨论串里的回复还引用着它，
   * 而"有回复保留占位"要求那一层还在（正文由读模型抹掉，见 `toView`/`readBody`）。
   * 重复删除是幂等的（返回 `alreadyDeleted`），不报错 —— 用户连点两下不该看到失败。
   */
  async deleteComment(
    ctx: CallerContext,
    input: { commentId: string },
    injectedDb?: SqliteDatabase,
  ): Promise<{ deleted: boolean; alreadyDeleted: boolean; hasReplies: boolean }> {
    const userId = requireActiveUser(ctx);
    const commentId = parseCommentId(input.commentId);

    return withTransaction((tx) => {
      const db = tx.db;
      const comment = readCommentRow(db, commentId);
      if (comment.author_id !== userId) throw err.forbidden('只能删除自己发布的评论。');

      const hasReplies =
        (
          db
            .prepare(
              `SELECT count(*) AS c FROM comments
                WHERE (root_comment_id = ? OR reply_to_comment_id = ?)
                  AND published_revision_id IS NOT NULL AND deleted_at IS NULL`,
            )
            .get(commentId, commentId) as { c: number }
        ).c > 0;

      if (comment.deleted_at !== null) {
        return { deleted: false, alreadyDeleted: true, hasReplies };
      }

      // 条件更新：并发下两个人同时删，只有一个 changes=1，另一个按"已删除"返回。
      const now = nowMs();
      const res = db
        .prepare('UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(now, commentId);
      return { deleted: res.changes === 1, alreadyDeleted: res.changes !== 1, hasReplies };
    }, injectedDb);
  },

  /** 公开讨论组分页（仅顶层；`reply_to_comment_id IS NULL`）。 */
  async listRootComments(    contentEntityId: string,
    req: PageRequest,
    injectedDb?: SqliteDatabase,
  ): Promise<PageResult<CommentView>> {
    const entityId = parseEntityId(contentEntityId);
    const page = normalizePageRequest(req);
    return withRead((db) => {
      // 公开可见条件（架构第 78.2、79.3 节）：
      //  - 必须已有**当前公开修订**（未公开的新评论不进公开列表）；
      //  - 未隐藏（隐藏的顶层在有合法回复时给中性占位，但本切片不做隐藏态展示，
      //    一律不返回正文，避免泄露）；
      //  - **已删除的顶层**：有已公开回复的保留占位（讨论串不能凭空缺一层），
      //    没有回复的整条不出现（删了就该看不见）。
      // 计数与取数使用同一条件，避免 total 与实际条目不一致。
      const VISIBLE = `
        content_entity_id = ? AND reply_to_comment_id IS NULL AND root_comment_id IS NULL
        AND published_revision_id IS NOT NULL
        AND (
          deleted_at IS NULL
          OR EXISTS (
            SELECT 1 FROM comments r
             WHERE r.root_comment_id = comments.id AND r.published_revision_id IS NOT NULL
          )
        )`;

      const total = (
        db.prepare(`SELECT count(*) AS c FROM comments WHERE ${VISIBLE}`).get(entityId) as { c: number }
      ).c;

      const rows = db
        .prepare(
          `SELECT id, content_entity_id, author_id, reply_to_comment_id, root_comment_id,
                  published_revision_id, latest_submitted_revision_id,
                  created_at, first_published_at, edited_at, deleted_at
           FROM comments
           WHERE ${VISIBLE}
           ORDER BY first_published_at ASC, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(entityId, page.page_size, (page.page - 1) * page.page_size) as CommentRow[];

      const items = rows.map((row) => toView(row, readBody(db, row), countReplies(db, row.id)));
      return buildPage(items, total, page);
    }, injectedDb);
  },

  /** 组内回复分页（`root_comment_id = ?`，含直接回复与更深层回复，按时间正序）。 */
  async listReplies(
    rootCommentId: string,
    req: PageRequest,
    injectedDb?: SqliteDatabase,
  ): Promise<PageResult<CommentView>> {
    if (typeof rootCommentId !== 'string' || !isUuidV7(rootCommentId)) {
      throw err.input('顶层评论标识格式不正确。', [{ path: 'root_comment_id', message: '必须是规范 UUIDv7' }]);
    }
    const page = normalizePageRequest(req);
    return withRead((db) => {
      const root = db
        .prepare('SELECT id, reply_to_comment_id FROM comments WHERE id = ?')
        .get(rootCommentId) as { id: string; reply_to_comment_id: string | null } | undefined;
      // root 必须真的是顶层：指向一条回复就是调用方搞错了讨论组。
      if (!root || root.reply_to_comment_id !== null) {
        throw err.unavailable('讨论组不存在或已不可访问。');
      }

      // 回复同样只展示**已公开**项（架构第 79.3 节：未公开回复不进公开列表）；
      // 已删除的回复一律不展示（回复不可能有下级，没有"保留占位"的必要）。
      const total = (
        db
          .prepare(
            `SELECT count(*) AS c FROM comments
              WHERE root_comment_id = ? AND published_revision_id IS NOT NULL AND deleted_at IS NULL`,
          )
          .get(rootCommentId) as { c: number }
      ).c;

      const rows = db
        .prepare(
          `SELECT id, content_entity_id, author_id, reply_to_comment_id, root_comment_id,
                  published_revision_id, latest_submitted_revision_id,
                  created_at, first_published_at, edited_at, deleted_at
           FROM comments
           WHERE root_comment_id = ? AND published_revision_id IS NOT NULL AND deleted_at IS NULL
           ORDER BY first_published_at ASC, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(rootCommentId, page.page_size, (page.page - 1) * page.page_size) as CommentRow[];

      const items = rows.map((row) => toView(row, readBody(db, row), 0));
      return buildPage(items, total, page);
    }, injectedDb);
  },
};

/**
 * 评论提交的请求摘要：基于**已规范化**的业务输入，
 * 让“同键同内容”可靠判为重复、“同键不同内容”可靠判为复用。
 */
export function digestCommentRequest(
  contentEntityId: string,
  body: string,
  replyToCommentId: string | null,
): string {
  return digest({ contentEntityId, body, replyToCommentId });
}

/**
 * 评论**修改**的请求摘要。
 *
 * 与新建分开：新建的摘要基于内容+正文+被回复人；修改还要带上**评论标识**
 * （同一个人在不同评论下写了同样一句话，是两次不同的提交，不能因摘要相同就判为复用）。
 */
export function digestCommentEditRequest(commentId: string, body: string): string {
  return digest({ operation: 'edit_comment', commentId, body });
}

export type CommentsService = typeof commentsService;
