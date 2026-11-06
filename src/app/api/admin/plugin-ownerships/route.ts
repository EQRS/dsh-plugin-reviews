/**
 * 管理员 · 插件认领审核队列：GET /api/admin/plugin-ownerships?status=pending
 *
 * 认领（plugin_ownerships）是「开发者」身份的前置——插件表没有作者字段，
 * 作者只能靠 GitHub 账号匹配（自动通过）或主动认领（人工核实）确定。
 * 本接口只给队列读，不实现审定逻辑：审定在 ownership.ts 的 reviewClaim 里，
 * 后台页面与接口都只做「转发 + 权限」。
 *
 * 权限口径与其它后台接口一致：每次从库里读角色（isAdmin），非管理员 403，
 * 未登录 401——两者不混成一个状态码，否则前端无法区分「去登录」还是「去申请权限」。
 */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import type { OwnershipStatus } from '@/server/modules/roles/ownership';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

const STATUSES: readonly OwnershipStatus[] = ['pending', 'verified', 'rejected'];

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanAdmin(ctx);

    // 与反馈队列同一口径：不认识的取值**回落到 pending**，而不是报错或放开成 all。
    // 审核队列的默认视图必须是「待审」——把无效参数解释成「全部历史」会让人误以为队列清空了。
    const raw = new URL(request.url).searchParams.get('status') ?? 'pending';
    const status: OwnershipStatus | 'all' =
      raw === 'all' ? 'all' : STATUSES.includes(raw as OwnershipStatus) ? (raw as OwnershipStatus) : 'pending';

    const service = createPluginOwnershipService({ db: getDb() });
    const items = await service.listQueue(ctx, status);
    return okJson({ status, items }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
