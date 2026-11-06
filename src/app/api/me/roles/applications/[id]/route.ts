/**
 * 撤回自己的一条待审申请（设计 §5.2 / §3.2 状态机）。
 *
 * DELETE /api/me/roles/applications/{id}
 *
 * 只允许撤回 `pending`：已通过/已驳回是既成结论，撤回它们等于篡改审核记录。
 * 撤回后**没有冷却期**，可以立刻重新申请（设计 §3.2）。
 */
import { getDb } from '@/server/platform/db';
import { createRoleService } from '@/server/modules/roles/service';
import { booleanSetting } from '@/server/modules/settings';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const db = getDb();
    if (!booleanSetting(db, 'roles.enabled', true)) throw err.unavailable('身份申请暂未开放。');

    const ctx = await currentContext();
    if (ctx.userId === null) throw err.unauthenticated();

    const { id } = await context.params;
    const service = createRoleService({ db });
    const application = await service.withdrawApplication(ctx, id);
    return okJson(application, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
