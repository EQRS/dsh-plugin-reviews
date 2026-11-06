/**
 * 管理员 · 处理一条插件认领：POST /api/admin/plugin-ownerships/{id}
 *
 * body：`{ decision: 'verify' | 'reject', note?: string | null }`
 *
 * 三条边界：
 *  1. **先认人再读 body**：匿名 + 非法 body 应当是 403，不是 400（与 pack-appeals 一致）；
 *  2. **驳回必须给理由**：理由会原样回给申请人（见 listMine 的 reviewNote），
 *     空理由等于让用户看不到为什么被拒，所以在接口层就挡掉，不依赖界面；
 *  3. **不重复实现审定逻辑**：直接调 ownership.ts 的 reviewClaim，它会自己处理
 *     「已经处理过」「插件已有归属人」等冲突并抛出带人话的 409。
 */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

/** 与库里的 CHECK 一致（`claimed_note` 限 500 字）。 */
const MAX_NOTE = 500;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ownershipId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { ownershipId } = await params;
    const ctx = await currentContext();
    assertCanAdmin(ctx);

    const body = (await readJson(request)) as { decision?: unknown; note?: unknown };
    if (body.decision !== 'verify' && body.decision !== 'reject') {
      throw err.input('decision 必须是 verify 或 reject。', [{ path: 'decision', message: '不合法' }]);
    }

    const rawNote = typeof body.note === 'string' ? body.note.trim() : '';
    if (body.decision === 'reject' && rawNote.length === 0) {
      throw err.input('驳回时必须填写理由。', [{ path: 'note', message: '驳回理由不能为空' }]);
    }
    if (rawNote.length > MAX_NOTE) {
      throw err.input(`理由最多 ${MAX_NOTE} 字。`, [{ path: 'note', message: '超长' }]);
    }

    const service = createPluginOwnershipService({ db: getDb() });
    await service.reviewClaim(ctx, ownershipId, body.decision, rawNote.length > 0 ? rawNote : null);
    return okJson({ ownershipId, decision: body.decision }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
