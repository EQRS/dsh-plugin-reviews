/**
 * 管理员待办列表（架构第 90.1 节）。
 *
 * GET /api/admin/submissions?state=manual_review   待办列表
 *
 * 注意：人工决定不在本路由，而在
 * `POST /api/admin/submissions/{submissionId}/decisions`
 * （本路由没有动态段，早期把决定挂在这里会取不到 submissionId）。
 *
 * 权限每次从库里读（不缓存角色）；非管理员返回 403。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? 'manual_review';
    const allowed = ['pending', 'checking', 'needs_changes', 'manual_review', 'approved', 'published', 'ineligible'];
    if (!allowed.includes(state)) {
      throw err.input('未知的处理阶段。', [{ path: 'state', message: '取值不合法' }]);
    }

    const rows = getDb()
      .prepare(
        `SELECT s.id AS submission_id, s.submission_type, s.processing_state, s.state_version,
                s.submitted_at, u.nickname AS submitter_nickname,
                rev.title AS review_title
           FROM content_submissions s
           JOIN users u ON u.id = s.submitted_by
           LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id
          WHERE s.processing_state = ?
          ORDER BY s.submitted_at ASC, s.id ASC`,
      )
      .all(state) as {
      submission_id: string;
      submission_type: string;
      processing_state: string;
      state_version: number;
      submitted_at: number;
      submitter_nickname: string;
      review_title: string | null;
    }[];

    return okJson(
      {
        items: rows.map((r) => ({
          submissionId: r.submission_id,
          submissionType: r.submission_type,
          processingState: r.processing_state,
          stateVersion: r.state_version,
          submittedAt: new Date(r.submitted_at).toISOString(),
          submitterNickname: r.submitter_nickname,
          reviewTitle: r.review_title,
        })),
        total: rows.length,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
