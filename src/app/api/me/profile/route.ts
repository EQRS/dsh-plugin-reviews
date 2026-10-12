/**
 * 本人资料保存（架构第 11 节：首个管理员之外，用户可确认自己的展示昵称）。
 *
 * PATCH /api/me/profile   { nickname }
 *
 * 为什么有这个路由：`identity.updateProfile` 早就实现了，但**一直没有接口调用它** ——
 * 于是 GitHub 新用户的落地页（`/onboarding`）只能"看"不能"改"，资料确认形同虚设。
 *
 * 守卫全在模块里（未登录 → 401、账户被禁用 → 403、空白昵称 → 400），
 * 路由只做参数形状校验与错误映射，不重复实现业务规则。
 */

import { getDb } from '@/server/platform/db';
import { createIdentityService } from '@/server/modules/identity';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function PATCH(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { nickname?: unknown };

    if (body.nickname === undefined) {
      throw err.input('缺少要保存的字段。', [{ path: 'nickname', message: '至少提供昵称' }]);
    }
    if (typeof body.nickname !== 'string') {
      throw err.input('昵称必须是文本。', [{ path: 'nickname', message: '类型不正确' }]);
    }

    const identity = createIdentityService({ db: getDb() });
    await identity.updateProfile(ctx, { nickname: body.nickname });

    return okJson({ nickname: body.nickname.trim() }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
