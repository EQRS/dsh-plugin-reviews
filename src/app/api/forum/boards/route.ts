/**
 * 分区列表：GET /api/forum/boards
 *
 * 匿名可读（分区是公开的），但 canPost 对匿名一律 false。
 */

import { getDb } from '@/server/platform/db';
import { createForumBoardService } from '@/server/modules/forum/boards';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const service = createForumBoardService({ db: getDb() });
    return okJson({ items: await service.listBoards(ctx) }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
