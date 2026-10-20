/**
 * 资料纠错提交（`idea.md §2`）：登录用户指出插件展示名/简介有误，交管理员核对。
 *
 * 频控走 `rate_limits.corrections_per_hour`（默认 10 次/时/用户，后台可调）。
 * 幂等：同一人对同一插件、同一组建议值已有未处理请求时，返回那一条而不是再堆一条，
 * 所以那种情况**不占额度**。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createCorrectionsService } from '@/server/modules/corrections';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pluginId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { pluginId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as {
      proposed?: unknown;
      description?: unknown;
      referenceUrl?: unknown;
    };
    if (body.proposed === null || typeof body.proposed !== 'object' || Array.isArray(body.proposed)) {
      throw err.input('proposed 必须是"字段 → 新值"的对象。', [{ path: 'proposed', message: '格式不合法' }]);
    }
    if (typeof body.description !== 'string') {
      throw err.input('请说明要纠正什么。', [{ path: 'description', message: '必填' }]);
    }

    const db = getDb();
    const ticket = await enforceRateLimit(
      db,
      'correction',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.correction),
    );

    try {
      const service = createCorrectionsService({ db });
      const result = await service.createCorrection(ctx, {
        pluginId,
        proposed: body.proposed as Record<string, unknown>,
        description: body.description,
        referenceUrl: typeof body.referenceUrl === 'string' ? body.referenceUrl : null,
      });
      if (!result.created) await refundQuietly(ticket);
      return okJson(result, requestId, result.created ? 201 : 200);
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
