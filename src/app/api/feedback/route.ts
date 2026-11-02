/**
 * 问题反馈（纯私有）：提交与我的列表。
 *
 * POST /api/feedback  { kind, title, body, pageUrl?, contextJson? }
 * GET  /api/feedback  ?page=1
 *
 * 频控走 `rate_limits.feedback_per_hour`（默认 10 次/时/用户，后台可调）。
 * 命中 24 小时去重时不新建票，因此**退还额度**（与举报接口同一口径）。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { booleanSetting, rateLimitOverrideFor } from '@/server/modules/settings';
import { createFeedbackService } from '@/server/modules/feedback';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 鉴权先于读 body：匿名/停用账号不该先拿到「参数错误」
    assertCanWrite(ctx);

    const db = getDb();
    // 开关关闭时整条通路当作不存在（404），与管理员隐藏入口的口径一致
    if (!booleanSetting(db, 'feedback.enabled', true)) throw err.unavailable('问题反馈暂未开放。');

    const body = (await readJson(request)) as {
      kind?: unknown;
      title?: unknown;
      body?: unknown;
      pageUrl?: unknown;
      contextJson?: unknown;
    };
    if (typeof body.kind !== 'string') {
      throw err.input('缺少反馈类型。', [{ path: 'kind', message: '必填' }]);
    }

    const ticket = await enforceRateLimit(
      db,
      'feedback',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.feedback),
    );

    try {
      const service = createFeedbackService({ db });
      const result = await service.createTicket(ctx, {
        kind: body.kind,
        title: body.title,
        body: body.body,
        pageUrl: body.pageUrl,
        contextJson: body.contextJson,
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

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (ctx.userId === null) throw err.unauthenticated();
    const db = getDb();
    if (!booleanSetting(db, 'feedback.enabled', true)) throw err.unavailable('问题反馈暂未开放。');
    const page = Number.parseInt(new URL(request.url).searchParams.get('page') ?? '1', 10);
    const service = createFeedbackService({ db });
    return okJson(await service.listMine(ctx, { page: Number.isFinite(page) ? page : 1 }), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
