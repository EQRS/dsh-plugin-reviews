/**
 * 举报（`idea.md §20`）：登录用户举报评测 / 评论 / 整合包版本，交管理员处理。
 *
 * 频控走 `rate_limits.reports_per_hour`（默认 20 次/时/用户，后台可调）。
 * 幂等：同一人对同一目标同一原因已有未处理举报时，返回那一条而不是再堆一条
 * （服务层部分唯一索引兜底），所以这里**不另扣额度**。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createInteractionsService, REPORT_REASON_LABELS, type ReportReason, type ReportTargetKind } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../_lib/context';

export const runtime = 'nodejs';

const TARGET_KINDS: ReportTargetKind[] = ['review', 'comment', 'pack_release'];

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as {
      targetKind?: unknown;
      targetId?: unknown;
      reason?: unknown;
      detail?: unknown;
    };
    if (typeof body.targetKind !== 'string' || !TARGET_KINDS.includes(body.targetKind as ReportTargetKind)) {
      throw err.input('举报目标类型不合法。', [{ path: 'targetKind', message: 'review / comment / pack_release' }]);
    }
    if (typeof body.targetId !== 'string' || body.targetId.trim().length === 0) {
      throw err.input('缺少举报目标。', [{ path: 'targetId', message: '必填' }]);
    }
    if (typeof body.reason !== 'string' || !(body.reason in REPORT_REASON_LABELS)) {
      throw err.input('举报原因不合法。', [
        { path: 'reason', message: `可选：${Object.keys(REPORT_REASON_LABELS).join(' / ')}` },
      ]);
    }

    const db = getDb();
    const ticket = await enforceRateLimit(
      db,
      'report',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.report),
    );

    try {
      const service = createInteractionsService({ db });
      const result = await service.createReport(ctx, {
        targetKind: body.targetKind as ReportTargetKind,
        targetId: body.targetId,
        reason: body.reason as ReportReason,
        detail: typeof body.detail === 'string' ? body.detail : null,
      });
      // 命中"已有未处理举报"= 没产生新记录，不占额度
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
