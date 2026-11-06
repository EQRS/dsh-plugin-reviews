/**
 * 讨论区 · 附件 id 的两种口径与解析。
 *
 * 这里最容易搞混的一件事（曾经就是这么错的）：
 *
 *   * `attachments.id` —— 附件身份。上传控件登记时拿到的就是它，
 *     媒体接口回给前端的AttachmentView.attachmentId 也是它。
 *   * `attachment_files.id` —— 文件版本。讨论区的三张引用表
 *     （forum_post_attachment_links / forum_reply_attachment_links /
 *      forum_post_draft_attachment_links）的 file_id 外键指向的是它。
 *
 * 前端只拿得到前者（后者在 AttachmentView.displayFileId 里，就绪时才有值），
 * 所以服务端在写入引用之前必须做一次「附件 id → 文件 id」解析；
 * 直接拿附件 id 当文件 id 写库会被外键挡下，再被归属触发器转成 ABORT，
 * 最后以一个 500 的形式出现在用户面前。
 *
 * 解析规则（fail-closed，不猜）：
 *   * 每个 id 先按 attachment_files.id 找；找不到再按 attachments.id 找它的 display 变体；
 *     两处都找不到 → 附件不存在；
 *   * 只接受就绪的文件：附件未就绪 / 附件失败 / 文件本身未就绪都给 not_ready，
 *     与「不是你的附件」分开报，用户才知道该重传还是别乱挂；
 *   * 只接受 display 变体：原图不参与任何正文引用（与媒体模块的公开读取口径一致）。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';

/** 文件版本在引用里的用途：正文图 / 封面图。 */
export type AttachmentFileUsage = 'body' | 'cover';

interface ResolvedRow {
  file_id: string;
  attachment_id: string;
  uploaded_by: string;
  variant_role: 'original' | 'display';
  file_state: 'pending' | 'ready' | 'failed';
  attachment_state: 'pending' | 'processing' | 'ready' | 'failed';
}

/**
 * 把「附件 id 或文件 id」解析成 attachment_files.id，并校验归属与就绪度。
 *
 * 重复 id 会先去重；没带附件（undefined / null / 空数组）返回空数组。
 */
export function resolveAttachmentFileIds(
  conn: SqliteDatabase,
  input: { raw: unknown; ownerId: string; field?: string; usage?: AttachmentFileUsage },
): string[] {
  const field = input.field ?? 'attachmentIds';
  const usage = input.usage ?? 'body';
  if (input.raw === undefined || input.raw === null) return [];
  if (!Array.isArray(input.raw)) {
    throw err.input('附件列表格式不对。', [{ path: field, message: '应为数组' }]);
  }
  if (input.raw.length === 0) return [];

  const ids: string[] = [];
  for (const raw of input.raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw err.input('附件标识不合法。', [{ path: field, message: '非法值' }]);
    }
    if (!ids.includes(raw)) ids.push(raw);
  }

  const resolved: string[] = [];
  for (const id of ids) {
    // 一个 id 可能同时是文件 id 与附件 id（极少见但可能）：
    // 先按文件 id 取候选，取不到再按附件 id 取它的 display 变体。
    const candidates = conn
      .prepare(
        `SELECT f.id AS file_id, f.attachment_id, a.uploaded_by, f.variant_role,
                f.processing_state AS file_state, a.processing_state AS attachment_state
           FROM attachment_files f
           JOIN attachments a ON a.id = f.attachment_id
          WHERE f.id = ?
          UNION ALL
         SELECT f.id AS file_id, f.attachment_id, a.uploaded_by, f.variant_role,
                f.processing_state AS file_state, a.processing_state AS attachment_state
           FROM attachments a
           JOIN attachment_files f ON f.attachment_id = a.id AND f.variant_role = 'display'
          WHERE a.id = ?
            AND NOT EXISTS (SELECT 1 FROM attachment_files x WHERE x.id = ?)`,
      )
      .all(id, id, id) as ResolvedRow[];

    // 同一份内容若同时拿到 original 与 display 两个候选，引用一律用 display。
    const display = candidates.find((c) => c.variant_role === 'display');
    const chosen = display ?? candidates[0];
    if (!chosen) throw err.input('附件不存在或已失效。', [{ path: field, message: '未找到' }]);

    if (chosen.attachment_state !== 'ready' || chosen.file_state !== 'ready') {
      throw err.input('图片还没处理好，请稍后再试。', [{ path: field, message: 'not_ready' }]);
    }

    // 归属：与 trg_forum_*_attachment_owner_insert 同一口径（只能挂本人上传的图），
    // 在这里先判一次是为了给出人话，而不是把触发器的 ABORT 抛出去。
    if (chosen.uploaded_by !== input.ownerId) {
      throw err.forbidden(usage === 'cover' ? '只能使用自己上传的图片。' : '只能引用自己上传的图片。');
    }

    if (chosen.variant_role !== 'display') {
      throw err.input('原图不能直接引用，请使用展示图。', [{ path: field, message: 'original' }]);
    }

    if (!resolved.includes(chosen.file_id)) resolved.push(chosen.file_id);
  }

  return resolved;
}
