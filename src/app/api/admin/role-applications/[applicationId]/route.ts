/**
 * 管理员 · 处理一条身份申请：POST /api/admin/role-applications/{id}
 *
 * body：`{ decision: 'approve' | 'reject', note?: string | null }`
 *
 * 三件事在接口层就要守住，不能指望界面：
 *  1. **先认人再读 body**：匿名 + 非法 body 应当是 403，不是 400；
 *  2. **驳回必须写理由**：理由会作为通知正文回给申请人（设计 §7 role_application_result），
 *     空理由等于让人不知道错在哪；
 *  3. **长度与库里 CHECK 一致**（`review_note` 限 500 字），截断而不是放行——
 *     超长直接报 400，让用户知道要删字，而不是悄悄截掉半句话。
 *
 * 状态机（pending → approved / rejected）由身份服务负责，本路由只做转发与入参校验。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

const MAX_NOTE = 500;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ applicationId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { applicationId } = await params;
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核身份申请。');

    const body = (await readJson(request)) as { decision?: unknown; note?: unknown };
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw err.input('decision 必须是 approve 或 reject。', [{ path: 'decision', message: '不合法' }]);
    }

    const rawNote = typeof body.note === 'string' ? body.note.trim() : '';
    if (body.decision === 'reject' && rawNote.length === 0) {
      throw err.input('驳回时必须填写理由。', [{ path: 'note', message: '驳回理由不能为空' }]);
    }
    if (rawNote.length > MAX_NOTE) {
      throw err.input(`理由最多 ${MAX_NOTE} 字。`, [{ path: 'note', message: '超长' }]);
    }

    let mod: typeof import('@/server/modules/roles/service');
    try {
      mod = await import('@/server/modules/roles/service');
    } catch {
      return errorResponse(err.internal('身份服务尚未就绪（src/server/modules/roles/service.ts 未交付）。'), requestId);
    }

    const service = mod.createRoleService({ db: getDb() });
    await service.reviewApplication(ctx, applicationId, body.decision, rawNote.length > 0 ? rawNote : null);
    return okJson({ applicationId, decision: body.decision }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
