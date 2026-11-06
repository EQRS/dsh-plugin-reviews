/**
 * 管理员 · 身份申请审核队列：GET /api/admin/role-applications?status=pending
 *
 * 数据来源是身份服务 `roles/service.ts` 的 `listApplicationsForAdmin(ctx, status)`
 * （设计文档 §5.2 的接口契约）。**本路由不直接读库**：申请表的口径
 * （哪些状态算待审、evidence 快照怎么反序列化、申请人昵称从哪来）属于身份服务的职责，
 * 绕过去就等于把同一份判断写两遍，早晚与它不一致。
 *
 * 若身份服务尚未落地（另一队友仍在写），转发层会抛出一个**明确的内部错误**
 * （status: 'unavailable'），而不是把「服务不在」伪装成 200 空列表——
 * 空列表会让人误以为队列真的清空了，比报错更危险。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

/** 与 0040 迁移里 role_applications.status 的 CHECK 一致。 */
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
type ApplicationStatus = (typeof STATUSES)[number];

function normStatus(raw: string | null): ApplicationStatus | 'all' {
  if (raw === 'all') return 'all';
  // 不认识的取值回落到 pending：审核队列的默认视图必须是「待审」，
  // 把无效参数解释成「全部历史」会让人误以为没有待办了。
  return raw !== null && (STATUSES as readonly string[]).includes(raw) ? (raw as ApplicationStatus) : 'pending';
}

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    // 先认人再加载身份服务：服务模块还没落地时，匿名/非管理员仍应拿到 403，
    // 不能因为「实现不在」先把所有人都打回 500（错误码要说真话）。
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以查看身份申请队列。');

    const status = normStatus(new URL(request.url).searchParams.get('status'));

    let mod: typeof import('@/server/modules/roles/service');
    try {
      mod = await import('@/server/modules/roles/service');
    } catch {
      return errorResponse(err.internal('身份服务尚未就绪（src/server/modules/roles/service.ts 未交付）。'), requestId);
    }

    const service = mod.createRoleService({ db: getDb() });
    const items = await service.listApplicationsForAdmin(ctx, status);
    return okJson({ status, items }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
