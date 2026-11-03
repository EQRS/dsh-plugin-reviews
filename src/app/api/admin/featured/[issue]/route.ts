/**
 * 管理端单期：读取 / 保存（整份清单）/ 删除草稿。
 *
 * GET    /api/admin/featured/12
 * PATCH  /api/admin/featured/12   { title, theme, prefaceMd, items[], expectedVersion }
 * DELETE /api/admin/featured/12   仅草稿
 */

import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import type { FeaturedItemInput } from '@/server/modules/featured';
import { err } from '@/packages/common/errors';
import { assertCanAdmin } from '@/server/platform/context';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

async function readIssue(params: Promise<{ issue: string }>): Promise<number> {
  const { issue } = await params;
  const issueNumber = Number.parseInt(issue, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw err.input('期号不合法。', [{ path: 'issue', message: '正整数' }]);
  }
  return issueNumber;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ issue: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    // 鉴权先于路径参数解析：匿名 + 非法期号应当是 401，不是 400。
    const ctx = await currentContext();
    assertCanAdmin(ctx);
    const issueNumber = await readIssue(params);
    const service = createFeaturedService({ db: getDb() });
    return okJson(await service.getForEdit(ctx, issueNumber), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ issue: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    // 鉴权先于路径参数解析与读 body：匿名/越权请求不该先拿到「参数错误」(400)。
    const ctx = await currentContext();
    assertCanAdmin(ctx);
    const issueNumber = await readIssue(params);
    const body = (await readJson(request)) as {
      title?: unknown;
      theme?: unknown;
      prefaceMd?: unknown;
      items?: unknown;
      expectedVersion?: unknown;
    };
    if (typeof body.title !== 'string' || typeof body.theme !== 'string') {
      throw err.input('标题与主题必填。', [{ path: 'title', message: '必填' }]);
    }
    if (!Array.isArray(body.items)) {
      throw err.input('缺少插件清单。', [{ path: 'items', message: '必填' }]);
    }
    if (typeof body.expectedVersion !== 'number') {
      throw err.input('缺少预期版本。', [{ path: 'expectedVersion', message: '必填' }]);
    }
    const service = createFeaturedService({ db: getDb() });
    const result = await service.saveDraft(ctx, issueNumber, {
      title: body.title,
      theme: body.theme,
      prefaceMd: typeof body.prefaceMd === 'string' ? body.prefaceMd : '',
      items: body.items as FeaturedItemInput[],
      expectedVersion: body.expectedVersion,
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ issue: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    // 鉴权先于路径参数解析：匿名 + 非法期号应当是 401，不是 400。
    const ctx = await currentContext();
    assertCanAdmin(ctx);
    const issueNumber = await readIssue(params);
    const service = createFeaturedService({ db: getDb() });
    return okJson(await service.deleteDraft(ctx, issueNumber), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
