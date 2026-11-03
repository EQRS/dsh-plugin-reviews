/**
 * 讨论区图片登记：POST /api/forum/attachments  { originalFilename }
 *
 * 为什么不复用 /api/drafts/{draftId}/attachments：那个接口按草稿归属校验、
 * 按草稿创建时间算"每篇图片数"——讨论区没有内容草稿这个锚点，硬套要靠编一个
 * 假草稿 id，比单独一条入口更糟。
 *
 * 这里只登记附件身份（pending），字节仍走 PUT /api/attachments/{id}/file，
 * 状态查询走 GET /api/attachments/{id}：与内容图片是同一条上传链路，
 * 只是"这张图属于哪"由帖子/回复的引用表决定，而不是草稿。
 *
 * 限额：每篇帖子/回复最多 media.max_images_per_review 张（默认值与评测一致）。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withTransaction } from '@/server/platform/tx';
import { numberSetting } from '@/server/modules/settings';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

/** 与媒体模块的内置硬上限保持一致。 */
const HARD_MAX_PER_ENTRY = 9;

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as { originalFilename?: unknown };
    const filename = typeof body.originalFilename === 'string' ? body.originalFilename.trim() : '';
    if (filename.length === 0) {
      throw err.input('缺少文件名。', [{ path: 'originalFilename', message: '必填' }]);
    }

    const db = getDb();
    const maxPerEntry = Math.min(
      numberSetting(db, 'media.max_images_per_review', HARD_MAX_PER_ENTRY),
      HARD_MAX_PER_ENTRY,
    );

    const created = withTransaction((tx) => {
      const conn = tx.db;
      const now = nowMs();
      // 统计"最近 2 小时内该用户已登记但未过期的图片"作为粗粒度配额：
      // 讨论区没有"一篇"这个锚点（图先传后引用），按时间窗限流不会误伤，
      // 也挡得住脚本批量刷图。
      const recent = (
        conn
          .prepare(
            `SELECT COUNT(*) AS c FROM attachments
              WHERE uploaded_by = ? AND processing_state <> 'failed' AND created_at >= ?`,
          )
          .get(ctx.userId, now - 2 * 3600_000) as { c: number }
      ).c;
      if (Number(recent) >= maxPerEntry * 5) {
        throw err.input('短时间内上传的图片太多了，请稍后再试。', [
          { path: 'originalFilename', message: '超出上传频率' },
        ]);
      }

      const id = newId();
      conn
        .prepare(
          `INSERT INTO attachments (id, uploaded_by, original_filename, processing_state, created_at)
           VALUES (?, ?, ?, 'pending', ?)`,
        )
        .run(id, ctx.userId, filename, now);
      return { attachmentId: id };
    }, db);

    return okJson(
      { ...created, uploadUrl: '/api/attachments/' + created.attachmentId + '/file' },
      requestId,
      201,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
