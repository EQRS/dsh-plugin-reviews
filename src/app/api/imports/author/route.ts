/**
 * 作者文件夹导入：登记批次与输入清单（不传字节）。
 *
 * POST /api/imports/author  { inputs: [{path,kind,byteSize,sha256}], requestKey }
 */

import { getDb } from '@/server/platform/db';
import { createAuthorImportService } from '@/server/modules/imports/author';
import { err } from '@/packages/common/errors';
import { assertCanWrite } from '@/server/platform/context';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 先认人再读 body：匿名 + 非法 body 应当是 401，不是 400。
    assertCanWrite(ctx);
    const body = (await readJson(request)) as { inputs?: unknown; requestKey?: unknown };
    if (!Array.isArray(body.inputs)) {
      throw err.input('缺少文件清单。', [{ path: 'inputs', message: '必填' }]);
    }
    if (typeof body.requestKey !== 'string' || body.requestKey.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }

    const service = createAuthorImportService({ db: getDb() });
    const result = await service.createBatch(ctx, {
      inputs: body.inputs as Parameters<typeof service.createBatch>[1]['inputs'],
      requestKey: body.requestKey,
    });
    return okJson(result, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
