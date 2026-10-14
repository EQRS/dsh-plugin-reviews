/**
 * 业务配置（`idea.md §24`：常用参数后台可调 + 修改记录）。
 *
 * GET /api/admin/settings   当前生效值 + 可配置项定义 + 最近修改记录
 * PUT /api/admin/settings   { changes: {键: 值}, reason, requestKey }
 *
 * 权限每次从库里读（不缓存角色）；非管理员 403。
 * 修改**必须填原因**（规格要求"调整留记录"），且与现状相同的值不算一次变更（不产生修订）。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createSettingsService } from '@/server/modules/settings';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const service = createSettingsService({ db: getDb() });
    const model = await service.read();
    const history = await service.history(20);
    return okJson({ ...model, history }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const body = (await readJson(request)) as { changes?: unknown; reason?: unknown; requestKey?: unknown };
    if (typeof body.changes !== 'object' || body.changes === null || Array.isArray(body.changes)) {
      throw err.input('changes 必须是"键 → 值"的对象。', [{ path: 'changes', message: '格式不合法' }]);
    }
    if (typeof body.reason !== 'string' || typeof body.requestKey !== 'string') {
      throw err.input('缺少修改原因或请求标识。', [
        { path: 'reason', message: '必填' },
        { path: 'requestKey', message: '必填' },
      ]);
    }

    const service = createSettingsService({ db: getDb() });
    const result = await service.update(ctx, {
      changes: body.changes as Record<string, unknown>,
      reason: body.reason,
      requestKey: body.requestKey,
    });
    // revisionId 为空 = 请求值与现状完全相同（没有产生任何变更），不是错误。
    return okJson(
      {
        revision_id: result.revisionId,
        revision_number: result.revisionNumber,
        changed: result.applied,
        effective: result.effective,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
