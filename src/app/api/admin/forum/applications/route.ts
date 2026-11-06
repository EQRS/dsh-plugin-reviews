/** 后台：分区申请队列 GET /api/admin/forum/applications?status=pending */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { createForumBoardApplicationService } from '@/server/modules/forum/applications';
import type { BoardApplicationStatus } from '@/packages/common/forum';
import { currentContext, okJson, errorResponse, requestMeta, assertForumEnabled } from '../../../_lib/context';

export const runtime = 'nodejs';

const STATUSES: BoardApplicationStatus[] = ['pending', 'approved', 'rejected'];

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const ctx = await currentContext();
    assertCanAdmin(ctx);
    const url = new URL(request.url);
    const raw = url.searchParams.get('status');
    const status = STATUSES.includes(raw as BoardApplicationStatus) ? (raw as BoardApplicationStatus) : 'pending';
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const service = createForumBoardApplicationService({ db: getDb() });
    return okJson(await service.listQueue(ctx, { status, page: Number.isFinite(page) ? page : 1 }), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
