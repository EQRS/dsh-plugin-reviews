/**
 * 管理员隐藏 / 取消隐藏内容（`docs/README-切片说明.md` §2.1 里「仍缺：管理员隐藏评论并记原因」的接口半）。
 *
 * POST /api/admin/content/{contentId}/visibility
 *   body: { action: 'hide' | 'unhide', reason, expectedVisibilityControlVersion, requestKey }
 *  data: {
 *          action,
 *          hidden, publicly_visible, has_published_revision, withdrawn,  // 当前可见性（服务层解析）
 *          control_version, hidden_at,
 *          replayed
 *        }
 *
 * 职责边界（硬约束）：本路由**只做**权限、入参校验、控制版本前置比对与幂等键转发。
 * 隐藏/取消隐藏的语义、隐藏三件套（`hidden_at` / `hidden_by` / `hidden_reason`）的成对写入、
 * `visibility_control_version` 递增，全部由 `contentService.hide` / `contentService.unhide`
 * 在各自的事务里完成 —— 这里不写任何 SQL，也不复制一份"公开与否"的判断：
 * 公开状态一律回服务层的 `resolveVisibility` 结果（唯一真相：有效公开修订 + 未撤回 + 未隐藏）。
 *
 * 三个如实报告点：
 *  1. **`unhide` 不自动重新发布**。服务层注释写明「解除隐藏只是恢复『可公开』，并不等于恢复公开：
 *     撤回状态仍独立生效」。所以返回值同时给出 `withdrawn` / `has_published_revision` /
 *     `publicly_visible`，由界面如实说明；本路由**不**顺手改公开状态（那会绕过发布流程与复核）。
 *  2. **版本不符 → 409 `version_conflict`**，带上 `current_version` / `expected_version`，
 *     不假装成功。注意校验的位置：`contentService.hide/unhide` 的签名**不收**控制版本
 *     （见 `docs/模块签名契约.md` §4 与 `src/server/modules/content/index.ts`），所以版本比对
 *     只能在路由层做一次「读—比」，真正的落地保护是服务层 UPDATE 里的状态条件
 *     （`WHERE hidden_at IS NULL` / `WHERE hidden_at IS NOT NULL`）：并发下后到者会被服务层拒成 409，
 *     不会重复隐藏或误解除。
 *  3. **`replayed` 目前结构上只能是 `false`**。`contentService.hide/unhide` 对 `requestKey` 只做
 *     非空校验后就 `void requestKey`，服务层对这两个动作**没有** `request_key` / `operation_records`
 *     去重（`docs/模块签名契约.md` §9.3 已把这一点登记为已知缺口）。接口层不自己另建去重台账 ——
 *     那会变成第二套真相，也与"审计与去重都在服务层"的边界冲突。
 *     后果要照实说：网络失败后用**同一个 `requestKey` 重试**，第二次会因为目标状态已变而拿到
 *     409（`version_conflict`），**不是**幂等返回原结果。界面必须提示"刷新后看当前状态"，不能写成"已完成"。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { contentService } from '@/server/modules/content';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

/** 取字段：驼峰（与 `decisions` / `withdraw` 路由的既有 body 一致）优先，兼容 snake_case 写法。 */
function readBodyField(body: Record<string, unknown>, camel: string, snake: string): unknown {
  const camelValue = body[camel];
  return camelValue === undefined ? body[snake] : camelValue;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ contentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 权限判定放在任何业务读取之前：非管理员连"这条内容存不存在"都不该问出来。
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { contentId } = await params;

    const raw = await readJson(request);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw err.input('请求体必须是 JSON 对象。');
    }
    const body = raw as Record<string, unknown>;

    const action = body.action;
    if (action !== 'hide' && action !== 'unhide') {
      throw err.input('action 只能是 hide 或 unhide。', [{ path: 'action', message: '取值不合法' }]);
    }

    // hide 与 unhide 都**必须**留下理由：服务层的 `parseReason` 对这两个动作同样强制
    // （迁移里三件套必须"全空或全填"，管理操作不留理由就写不进去）。这里先给同一条稳定错误。
    const reason = body.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw err.input(action === 'hide' ? '隐藏必须填写原因。' : '解除隐藏必须填写原因。', [
        { path: 'reason', message: '必填' },
      ]);
    }

    const expectedRaw = readBodyField(body, 'expectedVisibilityControlVersion', 'expected_visibility_control_version');
    if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0) {
      throw err.input('缺少预期可见性控制版本。', [
        { path: 'expectedVisibilityControlVersion', message: '必须是非负整数' },
      ]);
    }
    const expectedVersion = expectedRaw as number;

    const requestKeyRaw = readBodyField(body, 'requestKey', 'request_key');
    if (typeof requestKeyRaw !== 'string' || requestKeyRaw.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }
    const requestKey = requestKeyRaw;

    const db = getDb();

    // 版本前置比对（服务层不看版本，见文件头第 2 点）。内容不存在时这里就是 404 target_unavailable，
    // 内容标识格式不合法是 400 input_invalid —— 都由服务层 `parseEntityId` 决定，不由本层猜。
    const before = await contentService.resolveVisibility(contentId, db);
    if (before.controlVersion !== expectedVersion) {
      throw err.conflict('可见性状态已被其他操作改变，请刷新后重试。', {
        current_version: before.controlVersion,
        expected_version: expectedVersion,
      });
    }

    // 幂等键原样转发给服务层（语义与去重归服务层；当前它只校验非空，见文件头第 3 点）。
    let hiddenAt: number | null;
    if (action === 'hide') {
      const hidden = await contentService.hide(ctx, { entityId: contentId, reason, requestKey }, db);
      hiddenAt = hidden.hiddenAt;
    } else {
      // 返回恒为 null（已解除隐藏）；公开与否仍由撤回状态与公开修订独立决定。
      hiddenAt = (await contentService.unhide(ctx, { entityId: contentId, reason, requestKey }, db)).hiddenAt;
    }

    // 结果状态再读一次服务层解析，而不是"我请求了 hide 所以它现在一定隐藏"。
    const after = await contentService.resolveVisibility(contentId, db);

    return okJson(
      {
        action,
        hidden: after.hidden,
        publicly_visible: after.publiclyVisible,
        has_published_revision: after.hasPublishedRevision,
        withdrawn: after.withdrawn,
        control_version: after.controlVersion,
        hidden_at: hiddenAt,
        // 服务层未实现这两个动作的 request_key 去重，所以只能是 false —— 不编造重放。
        replayed: false,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}