/**
 * 资料纠错（`idea.md §2`、§23）：用户反馈 → 管理员采纳/驳回 → 采纳的字段覆盖同步值。
 *
 * 三张表的分工写在迁移 0015 里。这里只强调**一条最容易写错的不变量**：
 *   `plugins.display_name / description` 永远是**同步来的原值**；
 *   管理员修正放在 `plugin_field_overrides`，**读取时**才覆盖。
 *   所以"恢复同步资料" = 删一行 override，不需要重新探测 GitHub。
 *   反过来，如果同步流程把修正值写回 `plugins`，下次刷新就再也分不清"哪份是原值"了。
 *
 * 与它配套的改动在 `modules/catalog/service.ts`：
 *   * 收录/刷新时**跳过**已被覆盖的字段（不能把修正冲掉）；
 *   * 列表与详情**合并**覆盖值再返回。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { deliverModerationResultNotification } from '@/server/modules/notifications';

/** 允许纠错的字段（白名单）。分类是仓库级的，不在其中 —— 理由见迁移 0015 的注释。 */
export const CORRECTION_FIELDS = ['display_name', 'description'] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];

export const CORRECTION_FIELD_LABELS: Record<CorrectionField, string> = {
  display_name: '展示名',
  description: '简介',
};

export type CorrectionState = 'open' | 'accepted' | 'rejected';

export interface CorrectionView {
  correctionId: string;
  pluginId: string;
  pluginLabel: string;
  submittedByNickname: string;
  proposed: Partial<Record<CorrectionField, string>>;
  description: string;
  referenceUrl: string | null;
  state: CorrectionState;
  createdAt: number;
}

export interface OverrideView {
  pluginId: string;
  fieldKey: CorrectionField;
  value: string;
  reason: string;
  updatedAt: number;
}

/** 字段值校验：两类字段的长度上限不同，超了明确拒绝（不静默截断）。 */
function parseFieldValue(field: CorrectionField, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw err.input(`${CORRECTION_FIELD_LABELS[field]}必须是文本。`, [{ path: field, message: '类型不合法' }]);
  }
  const value = raw.trim();
  const max = field === 'display_name' ? 200 : 2000;
  if (value.length === 0 || value.length > max) {
    throw err.input(`${CORRECTION_FIELD_LABELS[field]}需为 1–${max} 个字符。`, [
      { path: field, message: `1–${max} 字符` },
    ]);
  }
  return value;
}

function parseProposed(raw: unknown): Partial<Record<CorrectionField, string>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err.input('proposed 必须是"字段 → 新值"的对象。', [{ path: 'proposed', message: '格式不合法' }]);
  }
  const source = raw as Record<string, unknown>;
  const out: Partial<Record<CorrectionField, string>> = {};
  for (const key of Object.keys(source)) {
    if (!(CORRECTION_FIELDS as readonly string[]).includes(key)) {
      throw err.input(`不支持的纠错字段：${key}。`, [{ path: key, message: '不在白名单内' }]);
    }
  }
  for (const field of CORRECTION_FIELDS) {
    if (source[field] !== undefined) out[field] = parseFieldValue(field, source[field]);
  }
  if (Object.keys(out).length === 0) {
    throw err.input('至少要给出一个字段的修正值。', [{ path: 'proposed', message: '不能为空' }]);
  }
  return out;
}

/** 读取覆盖值（批量）：列表页一次查完，避免 N+1。 */
export function overridesFor(
  conn: SqliteDatabase,
  pluginIds: string[],
): Map<string, Partial<Record<CorrectionField, string>>> {
  const out = new Map<string, Partial<Record<CorrectionField, string>>>();
  if (pluginIds.length === 0) return out;
  const placeholders = pluginIds.map(() => '?').join(', ');
  const rows = conn
    .prepare(`SELECT plugin_id, field_key, value FROM plugin_field_overrides WHERE plugin_id IN (${placeholders})`)
    .all(...pluginIds) as Array<{ plugin_id: string; field_key: CorrectionField; value: string }>;
  for (const row of rows) {
    const current = out.get(row.plugin_id) ?? {};
    current[row.field_key] = row.value;
    out.set(row.plugin_id, current);
  }
  return out;
}

export function createCorrectionsService(deps: { db: SqliteDatabase }) {
  const { db } = deps;

  return {
    /** 用户提交纠错（登录；每个插件同一字段同时只允许一条未处理）。 */
    async createCorrection(
      ctx: CallerContext,
      input: {
        pluginId: string;
        proposed: Record<string, unknown>;
        description: string;
        referenceUrl?: string | null;
      },
      injectedDb?: SqliteDatabase,
    ): Promise<{ correctionId: string; created: boolean }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const proposed = parseProposed(input.proposed);
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (description.length === 0 || description.length > 2000) {
        throw err.input('请说明要纠正什么（1–2000 字）。', [{ path: 'description', message: '1–2000 字' }]);
      }
      let referenceUrl: string | null = null;
      if (typeof input.referenceUrl === 'string' && input.referenceUrl.trim().length > 0) {
        const candidate = input.referenceUrl.trim();
        if (candidate.length > 500 || !/^https?:\/\//i.test(candidate)) {
          throw err.input('参考链接必须是 http(s) 地址（≤500 字）。', [{ path: 'referenceUrl', message: '格式不合法' }]);
        }
        referenceUrl = candidate;
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        if (!conn.prepare('SELECT 1 AS x FROM plugins WHERE id = ?').get(input.pluginId)) {
          throw err.unavailable('要纠错的插件不存在。');
        }
        // 同一用户对同一插件的同组字段，若已有未处理请求，直接复用（防重复提交）
        const existing = conn
          .prepare(
            `SELECT id FROM plugin_correction_requests
              WHERE plugin_id = ? AND submitted_by = ? AND state = 'open' AND proposed = ?
              LIMIT 1`,
          )
          .get(input.pluginId, userId, JSON.stringify(proposed)) as { id: string } | undefined;
        if (existing) return { correctionId: existing.id, created: false };

        const correctionId = newId(nowMs());
        conn
          .prepare(
            `INSERT INTO plugin_correction_requests
               (id, plugin_id, submitted_by, proposed, description, reference_url, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
          )
          .run(correctionId, input.pluginId, userId, JSON.stringify(proposed), description, referenceUrl, nowMs());
        return { correctionId, created: true };
      }, injectedDb ?? db);
    },

    /** 后台队列。 */
    async listCorrections(
      ctx: CallerContext,
      req: { state?: CorrectionState | 'all'; limit?: number } = {},
      injectedDb?: SqliteDatabase,
    ): Promise<CorrectionView[]> {
      if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
      const state = req.state ?? 'open';
      const limit = Math.min(Math.max(req.limit ?? 50, 1), 100);
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT c.id, c.plugin_id, c.proposed, c.description, c.reference_url, c.state, c.created_at,
                    u.nickname AS submitter,
                    COALESCE(p.display_name, r.full_name, '(未知插件)') AS plugin_label
               FROM plugin_correction_requests c
               JOIN users u ON u.id = c.submitted_by
               JOIN plugins p ON p.id = c.plugin_id
               LEFT JOIN repositories r ON r.id = p.repository_id
              ${state === 'all' ? '' : 'WHERE c.state = ?'}
              ORDER BY c.created_at ASC, c.id ASC
              LIMIT ?`,
          )
          .all(...(state === 'all' ? [limit] : [state, limit])) as Array<{
          id: string;
          plugin_id: string;
          proposed: string;
          description: string;
          reference_url: string | null;
          state: CorrectionState;
          created_at: number;
          submitter: string;
          plugin_label: string;
        }>;
        return rows.map((r) => ({
          correctionId: r.id,
          pluginId: r.plugin_id,
          pluginLabel: r.plugin_label,
          submittedByNickname: r.submitter,
          proposed: JSON.parse(r.proposed) as Partial<Record<CorrectionField, string>>,
          description: r.description,
          referenceUrl: r.reference_url,
          state: r.state,
          createdAt: r.created_at,
        }));
      }, injectedDb ?? db);
    },

    /**
     * 处理一条纠错：`accept` 写入覆盖字段并通知提交者；`reject` 只通知。
     * 每次处理都写 `plugin_correction_handling_records`（§23 的历史追查要求）。
     */
    async handleCorrection(
      ctx: CallerContext,
      correctionId: string,
      input: { action: 'accept' | 'reject'; reason: string },
      injectedDb?: SqliteDatabase,
    ): Promise<{ state: CorrectionState; action: 'accept' | 'reject'; notified: number }> {
      if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
      const adminId = ctx.userId as string;
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length === 0) throw err.input('处理纠错必须填写原因。', [{ path: 'reason', message: '必填' }]);
      if (input.action !== 'accept' && input.action !== 'reject') {
        throw err.input('处理动作不合法。', [{ path: 'action', message: 'accept / reject' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const request = conn
          .prepare(
            `SELECT id, plugin_id, submitted_by, proposed, state FROM plugin_correction_requests WHERE id = ?`,
          )
          .get(correctionId) as
          | { id: string; plugin_id: string; submitted_by: string; proposed: string; state: CorrectionState }
          | undefined;
        if (!request) throw err.unavailable('纠错请求不存在（可能已被删除）。');
        if (request.state !== 'open') throw err.conflict('这条纠错已经处理过了。', { state: request.state });

        const now = nowMs();
        const nextState: CorrectionState = input.action === 'accept' ? 'accepted' : 'rejected';
        const proposed = JSON.parse(request.proposed) as Partial<Record<CorrectionField, string>>;

        conn
          .prepare('UPDATE plugin_correction_requests SET state = ? WHERE id = ?')
          .run(nextState, correctionId);
        conn
          .prepare(
            `INSERT INTO plugin_correction_handling_records
               (id, correction_request_id, plugin_id, handled_by, action, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(newId(now), correctionId, request.plugin_id, adminId, input.action, reason, now);

        if (input.action === 'accept') {
          const upsert = conn.prepare(
            `INSERT INTO plugin_field_overrides (id, plugin_id, field_key, value, updated_by, reason, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (plugin_id, field_key) DO UPDATE SET
               value = excluded.value,
               updated_by = excluded.updated_by,
               reason = excluded.reason,
               updated_at = excluded.updated_at`,
          );
          for (const field of CORRECTION_FIELDS) {
            const value = proposed[field];
            if (value === undefined) continue;
            upsert.run(newId(now), request.plugin_id, field, value, adminId, reason, now);
          }
        }

        // 结果通知提交者（采纳/驳回各一条；同一处理重放不重复）
        const delivered = deliverModerationResultNotification(conn, {
          recipientId: request.submitted_by,
          actorId: adminId,
          // 插件不是 content_entity：资料纠错的处理结果没有内容锚点（迁移 0016 已放开这一列）。
          contentEntityId: null,
          detail:
            input.action === 'accept'
              ? `你提交的资料纠错已被采纳：${Object.keys(proposed)
                  .map((f) => CORRECTION_FIELD_LABELS[f as CorrectionField])
                  .join('、')}已按建议修正。说明：${reason}`
              : `你提交的资料纠错未被采纳。说明：${reason}`,
          deduplicationKey: `correction_result:${correctionId}:${request.submitted_by}:${input.action}`,
          now,
        }).created;

        return { state: nextState, action: input.action, notified: delivered ? 1 : 0 };
      }, injectedDb ?? db);
    },

    /** 某个插件当前生效的覆盖值（详情页展示"该字段由管理员修正"）。 */
    async listOverrides(
      ctx: CallerContext,
      pluginId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<OverrideView[]> {
      if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT o.plugin_id, o.field_key, o.value, o.reason, o.updated_at
               FROM plugin_field_overrides o WHERE o.plugin_id = ? ORDER BY o.field_key`,
          )
          .all(pluginId) as Array<{
          plugin_id: string;
          field_key: CorrectionField;
          value: string;
          reason: string;
          updated_at: number;
        }>;
        return rows.map((r) => ({
          pluginId: r.plugin_id,
          fieldKey: r.field_key,
          value: r.value,
          reason: r.reason,
          updatedAt: r.updated_at,
        }));
      }, injectedDb ?? db);
    },

    /** 恢复同步资料：删掉某个字段的覆盖（不需要重新探测 GitHub）。 */
    async revertOverride(
      ctx: CallerContext,
      pluginId: string,
      fieldKey: CorrectionField,
      injectedDb?: SqliteDatabase,
    ): Promise<{ reverted: boolean }> {
      if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
      if (!(CORRECTION_FIELDS as readonly string[]).includes(fieldKey)) {
        throw err.input('字段不在白名单内。', [{ path: 'fieldKey', message: '取值不合法' }]);
      }
      const run = (conn: SqliteDatabase) =>
        conn.prepare('DELETE FROM plugin_field_overrides WHERE plugin_id = ? AND field_key = ?').run(pluginId, fieldKey)
          .changes > 0;
      if (injectedDb) return { reverted: withTransaction((tx) => run(tx.db), injectedDb) };
      return { reverted: withTransaction((tx) => run(tx.db), db) };
    },
  };
}

export type CorrectionsService = ReturnType<typeof createCorrectionsService>;

/** 路由层用（默认连接）。 */
export function correctionsService(): CorrectionsService {
  return createCorrectionsService({ db: getDb() });
}
