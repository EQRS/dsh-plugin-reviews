/**
 * 附件登记接口（架构第 70 节）。
 *
 * POST /api/drafts/{draftId}/attachments
 *
 * 只做"登记一次上传"：核验草稿归属与用途、检查限额，返回附件身份与有效上传上下文。
 * **登记不等于收到字节**，更不等于可以引用；字节接收在
 * `PUT /api/attachments/{attachmentId}/file`，状态查询在 `GET /api/attachments/{attachmentId}`。
 */

import { createMediaService } from '@/server/modules/media';
import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { draftId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as { originalFilename?: unknown; usage?: unknown };

    if (typeof body.originalFilename !== 'string' || body.originalFilename.trim() === '') {
      throw err.input('缺少文件名。', [{ path: 'originalFilename', message: '必填' }]);
    }
    const usage = body.usage === 'cover' ? 'cover' : 'body';

    const media = createMediaService({ db: getDb() });
    const created = await media.createAttachment(ctx, {
      draftId,
      originalFilename: body.originalFilename,
      usage,
    });
    return okJson(created, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
