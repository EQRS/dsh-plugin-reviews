/**
 * 我的身份 + 每个可申请身份的资格状态（设计 §5.2 / §5.1）。
 *
 * GET /api/me/roles
 *   → { authenticated, enabled, roles, applications, eligibility, cooldownDays, panel }
 *
 * 三条口径：
 *   1. `roles.enabled` 关闭时接口一律 404（与 forum.enabled / feedback.enabled 同口径），
 *      **不**返回空列表冒充"你什么身份都没有"——关掉入口和没有身份是两回事，藏起来比说假话好。
 *   2. 匿名不报 401，而是 `authenticated: false` 的空壳：本接口只读，页面也能据此渲染登录提示，
 *      不给一个点了才 401 的入口。
 *   3. `panel` 由纯函数 `buildRolePanel` 算出（四态判定见 packages/common/roles.ts），
 *      路由只负责取数与拼装，不在接口层写分支。
 *
 * 数据来源是服务层的 `listMyRoles`（设计 §5.2 只约定「我的身份 + 资格状态」，没有单独的资格接口）：
 * 它一次给出 roles / applications（每个身份一条汇总：eligibility、held、pending、冷却截止）。
 * 这里把它**翻译**成面板输入的形状，不改服务层一个字。
 */
import { getDb } from '@/server/platform/db';
import { createRoleService } from '@/server/modules/roles/service';
import { booleanSetting, numberSetting } from '@/server/modules/settings';
import { ROLE_TYPES, buildRolePanel, type HeldRole, type PendingApplication, type RejectedApplication, type RoleEligibility, type RoleType } from '@/packages/common/roles';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

/** 身份申请开关（缺省开）。页面与接口共用这一个读点，避免两处各读各的键。 */
export function rolesEnabled(db = getDb()): boolean {
  return booleanSetting(db, 'roles.enabled', true);
}

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const db = getDb();
    if (!rolesEnabled(db)) throw err.unavailable('身份申请暂未开放。');

    const ctx = await currentContext();
    if (ctx.userId === null) {
      return okJson(
        { authenticated: false, enabled: true, roles: [], applications: [], eligibility: null, cooldownDays: 0, panel: null },
        requestId,
      );
    }

    const service = createRoleService({ db });
    const mine = await service.listMyRoles(ctx);
    const cooldownDays = numberSetting(db, 'roles.application_cooldown_days', 30);

    // 只认 active：被撤销的身份不算「已是 X」，界面上该给他重新申请的资格。
    const heldRoles: HeldRole[] = mine.roles
      .filter((r) => r.status === 'active')
      .map((r) => ({ roleType: r.roleType, grantedAt: r.grantedAt }));

    const pending: PendingApplication[] = [];
    const rejected: RejectedApplication[] = [];
    const eligibility = {} as Record<RoleType, RoleEligibility>;

    for (const type of ROLE_TYPES) {
      const summary = mine.applications.find((a) => a.roleType === type);
      eligibility[type] = { count: summary?.count ?? 0, required: 1 };

      if (summary?.pendingApplicationId) {
        const row = mine.history.find((a) => a.id === summary.pendingApplicationId);
        pending.push({
          id: summary.pendingApplicationId,
          roleType: type,
          createdAt: row?.createdAt ?? 0,
          note: row?.note ?? null,
        });
      }
      // 驳回理由与驳回时刻取最近那一条被驳回的申请（冷却期从它起算）。
      if (summary?.lastRejectedApplicationId) {
        const row = mine.history.find((a) => a.id === summary.lastRejectedApplicationId);
        if (row) {
          rejected.push({
            id: row.id,
            roleType: type,
            reviewedAt: row.reviewedAt ?? row.createdAt,
            reviewNote: row.reviewNote,
          });
        }
      }
    }

    const panel = buildRolePanel({ roles: heldRoles, pending, rejected, eligibility, cooldownDays });

    return okJson(
      {
        authenticated: true,
        enabled: true,
        roles: heldRoles,
        applications: mine.applications,
        eligibility,
        cooldownDays,
        panel,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
