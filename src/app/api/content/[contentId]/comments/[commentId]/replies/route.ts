/**
 * 讨论组内的回复分页（架构第 78.2、79.3 节）。
 *
 * GET /api/content/{contentId}/comments/{commentId}/replies?page=&page_size=
 *
 * 为什么需要它：`commentsService.listReplies` 早就实现了（含公开修订过滤），
 * 但**没有任何路由暴露它** —— 结果界面上只能看到"3 条回复"这个数字，
 * 点不开、也回不了。回复是评论的常规动作，缺了它评论功能是半截的。
 *
 * 两道守卫，缺一不可：
 *  1. **内容可见性**：目标不公开 → 404，不返回讨论（与顶层列表同一条规矩）。
 *     这一步必须在路由层补：`listReplies` 只看评论自身是否已公开，
 *     它不知道所属内容是否被撤回/隐藏。
 *  2. **归属核对**：`commentId` 必须真的属于 `contentId` 且是顶层。
 *     否则可以拿一条可见内容的 ID 去读另一条隐藏内容下的讨论。
 *     顶层判断由 `listReplies` 自己做（它会拒绝指向回复的 ID），这里补归属。
 */

import { getDb } from '@/server/platform/db';
import { commentsService } from '@/server/modules/comments';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { isUuidV7 } from '@/packages/common/field-rules';
import { err } from '@/packages/common/errors';
import { okJson, errorResponse, requestMeta } from '../../../../../_lib/context';
import { parsePaging } from '@/app/api/_lib/pagination';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ contentId: string; commentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { contentId, commentId } = await params;
    const { page, pageSize } = parsePaging(new URL(request.url));
    const db = getDb();

    // 1) 所属内容必须当前公开。
    const vis = resolveVisibilityInTx(db, contentId);
    if (!vis.publiclyVisible) throw err.unavailable('该内容当前不可查看。');

    // 2) 该顶层评论必须属于这份内容。格式不对也走同一条 404，不泄露"是否存在这条评论"。
    if (!isUuidV7(commentId)) throw err.unavailable('讨论组不存在或已不可访问。');
    const owner = db
      .prepare('SELECT content_entity_id FROM comments WHERE id = ? AND reply_to_comment_id IS NULL')
      .get(commentId) as { content_entity_id: string } | undefined;
    if (!owner || owner.content_entity_id !== contentId) {
      throw err.unavailable('讨论组不存在或已不可访问。');
    }

    const result = await commentsService.listReplies(commentId, { page, page_size: pageSize }, db);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

// 回复列表是公开内容（匿名可读），登录与否看到的是同一份，因此本路由刻意不读会话。
export const dynamic = 'force-dynamic';
