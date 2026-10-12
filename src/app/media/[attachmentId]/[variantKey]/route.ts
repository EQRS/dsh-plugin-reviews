/**
 * 固定站内媒体读取（架构第 10 节）。
 *
 * GET /media/{attachmentId}/{variantKey}
 *
 * 规则：
 *  - 权限由 media 模块判定：只有**当前公开**修订引用的文件（且限 display 变体），
 *    或附件本人的草稿预览，才返回字节；
 *  - 地址是固定的站内地址，不绑定任何存储源域名或临时签名；
 *  - 未授权一律 404（不泄露"这张图存在"这件事本身）。
 */

import { createMediaService } from '@/server/modules/media';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../../api/_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string; variantKey: string }> },
): Promise<Response> {
  const { attachmentId, variantKey } = await params;

  // 变体键只接受注册过的两种，避免用任意键探测文件。
  if (variantKey !== 'DISPLAY' && variantKey !== 'ORIGINAL') {
    return new Response('Not Found', { status: 404 });
  }

  const viewer = await currentContext();
  const media = createMediaService({ db: getDb() });
  const found = await media.resolveReadable({ attachmentId, variantKey }, viewer);

  if (!found) {
    // 统一 404：不区分"不存在"与"无权限"，避免泄露私有内容的存在性。
    return new Response('Not Found', { status: 404 });
  }

  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      'content-type': found.mime,
      'content-length': String(found.bytes.byteLength),
      // 内容按附件 ID 与变体固定；控制器按可见性即时判断，因此允许私有缓存但不允许共享缓存。
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  });
}
