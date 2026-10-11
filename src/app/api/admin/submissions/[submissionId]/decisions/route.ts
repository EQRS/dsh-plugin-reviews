/**
 * 管理员人工审核决定（架构第 90.2 节）。
 *
 * POST /api/admin/submissions/{submissionId}/decisions
 *
 * 通过仍须满足结构、附件及类型发布条件；实际发布由发布流程另行核验资格。
 */

import { getDb } from '@/server/platform/db';
import { createModerationService } from '@/server/modules/moderation';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { submissionId } = await params;
    const body = (await readJson(request)) as {
      decision?: unknown;
      reason?: unknown;
      expectedStateVersion?: unknown;
      requestKey?: unknown;
    };

    if (body.decision !== 'approve' && body.decision !== 'needs_changes') {
      throw err.input('决定只能是通过或需修改。', [{ path: 'decision', message: '取值不合法' }]);
    }
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw err.input('必须填写处理原因。', [{ path: 'reason', message: '必填' }]);
    }
    if (!Number.isInteger(body.expectedStateVersion)) {
      throw err.input('缺少预期提交版本。', [{ path: 'expectedStateVersion', message: '必须是整数' }]);
    }
    if (typeof body.requestKey !== 'string' || body.requestKey.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }

    const moderation = createModerationService(getDb());
    const result = await moderation.decideByAdmin(ctx, {
      submissionId,
      decision: body.decision,
      reason: body.reason,
      expectedStateVersion: body.expectedStateVersion as number,
      requestKey: body.requestKey,
    });

    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
