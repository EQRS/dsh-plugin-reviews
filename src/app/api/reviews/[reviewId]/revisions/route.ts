/**
 * 评测修订历史（需求第 10 节：「作者与管理员可查完整修订」）。
 *
 * GET /api/reviews/{reviewId}/revisions
 *
 * 为什么要有这个接口：修订快照一直留在 `review_revisions` 里（触发器保证不可改写、
 * 不可删除），但此前**没有任何读取界面** —— 提交过几次、哪次是当前公开的，谁也看不到。
 *
 * 响应分两段，**权限判定全部在服务端**（不靠前端隐藏，前端隐藏挡不住直连请求）：
 *   · 公开部分（任何访客）：每份快照的提交时间与公开状态
 *     （当前公开 / 已被更新的修订取代 / 从未公开 / 文章已撤回），以及当前公开修订的标识；
 *     **绝不下发未公开修订的标题与正文**，也不下发提交的审核阶段（§6：公开页不展示私有处理进度）。
 *   · 私有部分（作者本人或管理员）：额外下发每份快照的标题、Markdown 原文与已净化 HTML，
 *     用于回看历史。
 *
 * 只读：`review_revisions` 由 0002 的 `trg_review_revisions_immutable` /
 * `trg_review_revisions_no_delete` 保护；本接口**不提供任何写入或回滚入口**。
 *
 * 404 的语义（架构第 65 节，不用 403 泄露「这里有私有内容」）：
 *   1. 评测不存在 → `target_unavailable`(404)；
 *   2. 评测存在但当前不公开（撤回／隐藏／尚未发布），且调用者既非作者也非管理员
 *      → 同样 `target_unavailable`(404)。公开页面在同样情况下也不展示修订历史（页面布局.md §6）。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { renderMarkdownToSafeHtml } from '@/server/platform/markdown';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReviewRow {
  review_id: string;
  published_revision_id: string | null;
  author_id: string;
}

interface RevisionRow {
  revision_id: string;
  revision_number: number;
  submitted_at: number;
  title: string;
  body_markdown: string;
  /** 该快照对应提交的处理状态；一份快照最多一条提交（部分唯一索引），所以 LEFT JOIN 不会翻倍。 */
  processing_state: string | null;
}

/** 公开状态：只暴露"读者能观察到的事实"，不含审核阶段。 */
type RevisionStatus = 'current' | 'superseded' | 'unpublished';

interface RevisionItem {
  revisionId: string;
  revisionNumber: number;
  submittedAt: string;
  status: RevisionStatus;
  /** 是否当前公开修订（`reviews.published_revision_id`）。 */
  isCurrentPublished: boolean;
  /** 是否曾经完成过发布（提交处理状态为 published）。 */
  wasPublished: boolean;
  /** 曾公开、但已被更新的公开修订取代。 */
  isSuperseded: boolean;
  /** 整篇当前是否已撤回（撤回是**内容级**状态，同一篇的所有修订一致）。 */
  isWithdrawn: boolean;
  /** 这份快照现在是否对读者可见（当前公开 + 文章当前公开）。 */
  publiclyAvailable: boolean;
  /** 以下三项只在 `canReadBodies` 为 true 时出现（作者本人或管理员）。 */
  title?: string;
  bodyMarkdown?: string;
  bodyHtml?: string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { reviewId } = await params;
    const db = getDb();
    const ctx = await currentContext();

    // ---- 1) 评测必须存在。不存在与"存在但不可访问"共用同一类错误，不泄露内部状态。 ----
    const review = db
      .prepare(
        `SELECT r.id AS review_id, r.published_revision_id, ce.author_id
           FROM reviews r
           JOIN content_entities ce ON ce.id = r.id
          WHERE r.id = ?`,
      )
      .get(reviewId) as ReviewRow | undefined;
    if (!review) throw err.unavailable('该评测不存在或已不可访问。');

    // ---- 2) 权限判定（服务端唯一真相，前端只负责呈现） ----
    // 作者本人：会话里的 userId 与 content_entities.author_id 一致即可。
    // 会话解析本身已拒绝禁用账户（identity.resolveSession 对 account_status 非 active 返回 null），
    // 所以这里不需要再看 accountStatus。
    const isAuthor = ctx.userId !== null && ctx.userId === review.author_id;
    const canReadBodies = isAuthor || isAdmin(ctx);

    // ---- 3) 可见性走 content 模块的统一判定，不另写一套「当前是否公开」 ----
    const vis = resolveVisibilityInTx(db, reviewId);

    if (!vis.publiclyVisible && !canReadBodies) {
      // 与 GET /api/reviews/{reviewId} 同一套文案：公开页本身也只显示这个状态，未新增泄露面。
      throw err.unavailable(
        vis.withdrawn ? '该评测已被作者撤回。' : vis.hidden ? '该评测当前不可查看。' : '该评测尚未发布。',
      );
    }

    // ---- 4) 读取修订列表 ----
    // 一份快照最多一条提交（uq_submissions_review_revision 部分唯一索引），LEFT JOIN 安全。
    // 只取 `processing_state` 用于判断"曾公开过"，**绝不把它下发给无正文权限的调用者**。
    const rows = db
      .prepare(
        `SELECT rev.id AS revision_id, rev.revision_number, rev.submitted_at,
                rev.title, rev.body_markdown,
                s.processing_state AS processing_state
           FROM review_revisions rev
           LEFT JOIN content_submissions s ON s.review_revision_id = rev.id
          WHERE rev.review_id = ?
          ORDER BY rev.revision_number DESC, rev.id DESC`,
      )
      .all(reviewId) as RevisionRow[];

    const revisions: RevisionItem[] = rows.map((row) => {
      const isCurrentPublished = review.published_revision_id === row.revision_id;
      const wasPublished = isCurrentPublished || row.processing_state === 'published';
      const isSuperseded = wasPublished && !isCurrentPublished;
      const status: RevisionStatus = isCurrentPublished ? 'current' : isSuperseded ? 'superseded' : 'unpublished';

      const item: RevisionItem = {
        revisionId: row.revision_id,
        revisionNumber: row.revision_number,
        submittedAt: new Date(row.submitted_at).toISOString(),
        status,
        isCurrentPublished,
        wasPublished,
        isSuperseded,
        isWithdrawn: vis.withdrawn,
        publiclyAvailable: isCurrentPublished && vis.publiclyVisible,
      };

      // 标题/正文只在这一条分支里出现：其余调用者的响应对象**根本不含这些键**。
      if (canReadBodies) {
        item.title = row.title;
        item.bodyMarkdown = row.body_markdown;
        // HTML 是经统一管线（rehype-sanitize）净化的展示结果；Markdown 原文才是权威内容。
        item.bodyHtml = renderMarkdownToSafeHtml(row.body_markdown);
      }
      return item;
    });

    // `页面布局.md` §6「公开页不展示私有处理进度」：
    // 对无正文权限的访客，**连"存在一条尚未公开的修订"都不该被看出来**，
    // 所以他的列表只保留**曾经公开过**的修订；作者与管理员看完整历史（含待审修订）。
    const visibleRevisions = canReadBodies ? revisions : revisions.filter((r) => r.wasPublished);

    return okJson(
      {
        reviewId,
        /** 当前公开修订的标识（没有公开修订时为 null）。 */
        currentPublishedRevisionId: review.published_revision_id,
        /** 本次响应是否包含标题与正文（作者本人或管理员为 true）。 */
        canReadBodies,
        /** 文章当前对读者是否公开（撤回/隐藏时为 false，此时只有作者与管理员能拿到本响应）。 */
        publiclyVisible: vis.publiclyVisible,
        withdrawn: vis.withdrawn,
        hidden: vis.hidden,
        total: visibleRevisions.length,
        revisions: visibleRevisions,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}