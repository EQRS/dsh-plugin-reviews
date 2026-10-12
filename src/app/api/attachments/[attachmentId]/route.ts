/**
 * 附件状态查询（架构第 70 节）。
 *
 * GET /api/attachments/{attachmentId}
 *
 * 只返回**本人有权查看**的附件；就绪时给出固定站内地址。
 * 作者通过它确认图片是否可引用、失败原因是什么，而不是靠猜。
 */

import { createMediaService } from '@/server/modules/media';
import { getDb } from '@/server/platform/db';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { attachmentId } = await params;
    const ctx = await currentContext();
    const media = createMediaService({ db: getDb() });
    const view = await media.getAttachment(ctx, attachmentId);
    return okJson(view, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
