/**
 * 提交一次身份申请（设计 §5.2 / §6）。
 *
 * POST /api/me/roles/applications   { roleType, note? }
 *
 * 守卫三层，各管一段，互不重复：
 *   * 路由层：`roles.enabled` 关闭 → 404（与 forum.enabled 同口径）；
 *   * 频控：`role_application` 每天 N 次（设置项 rate_limits.role_applications_per_day）；
 *   * 服务层：资格、冷却期、重复申请、账户状态 —— 那些规则只在一处实现（modules/roles/service.ts）。
 */
import { getDb } from '@/server/platform/db';
import { createRoleService, parseRoleType } from '@/server/modules/roles/service';
import { booleanSetting, rateLimitOverrideFor } from '@/server/modules/settings';
import { RATE_LIMIT_RULES, enforceRateLimit, refundQuietly, type RateLimitTicket } from '@/server/platform/rate-limit';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const db = getDb();
    if (!booleanSetting(db, 'roles.enabled', true)) throw err.unavailable('身份申请暂未开放。');

    const ctx = await currentContext();
    if (ctx.userId === null) throw err.unauthenticated();

    const body = (await readJson(request)) as { roleType?: unknown; note?: unknown };
    const roleType = parseRoleType(body.roleType);
    const note = typeof body.note === 'string' ? body.note : null;

    // 频控额度在**业务真正写成之前**就先扣了，所以下面任何一步失败都必须退回去。
    //
    // 审查指出的问题：服务层还会因「已持有该身份 / 有待审申请 / 处于冷却期 / 资格不足 /
    // note 超长」拒绝，这些全发生在频控之后 —— 用户点错 3 次，当天额度就烧光，
    // 只能等 24 小时。rate-limit.ts 的注释写得很清楚「没有产生业务变更时必须退还」，
    // refundQuietly 也早就提供，只是一直没人调用。
    let ticket: RateLimitTicket | null = null;
    try {
      ticket = await enforceRateLimit(
        db,
        'role_application',
        ctx.userId,
        1,
        await rateLimitOverrideFor(db, RATE_LIMIT_RULES.role_application),
      );

      const service = createRoleService({ db });
      const application = await service.applyForRole(ctx, roleType, note);
      ticket = null; // 成功落地，额度不退
      return okJson(application, requestId, 201);
    } finally {
      // 失败（含校验不通过、服务端内部错误）一律退还：用户没做错什么，不该烧他的额度。
      await refundQuietly(ticket);
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
