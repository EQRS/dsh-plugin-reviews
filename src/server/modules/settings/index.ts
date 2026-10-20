/**
 * 业务配置（`idea.md §24`、`参数与管理规则.md`）。
 *
 * 规划要求："业务参数集中配置 + 常用项后台可调 + 修改记录"。
 * 数据库里 `site_settings` / `configuration_revisions` 两张表**建库时就有**，此前零读写 ——
 * 这个模块把它们接上，并且只做一件本分的事：**给出"当前生效值"**，由各调用点自己去读。
 *
 * 三条设计纪律：
 *  1. **默认值只有一个来源**：`SETTING_DEFINITIONS`。库里有行就覆盖，没有就用默认值 ——
 *     不会出现"默认值在代码里写死 5、在迁移里又写 3"这种漂移。
 *  2. **只认定义过的键**：后台接口按定义校验（类型 / 范围），写进来的值一定合法；
 *     库里若有**不在定义里的键**（有人手改过库），不会静默吞掉 —— 读接口会把它列出来。
 *  3. **修改必留记录**：每次真实变更都写一条 `configuration_revisions`（含完整生效快照与本次变化），
 *     `site_settings` 的每一行都指向"是哪次修改把它改成这样的"。
 *     请求值**与现状完全相同**时不写任何行、不产生修订 —— 天然幂等，不靠请求键也不污染历史。
 */

import { isAdmin, type CallerContext } from '@/server/platform/context';
import type { SqliteDatabase } from '@/server/platform/db';
import { newId } from '@/server/platform/id';
import { err } from '@/packages/common/errors';

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  kind: 'integer' | 'boolean';
  defaultValue: number | boolean;
  /** 整数项的有效范围（含端点）。 */
  min?: number;
  max?: number;
  unit?: string;
}

/**
 * 可调参数清单（**只列真的被读取的**：列了却没人读，就是"有表无事"的翻版）。
 *
 * 目前接上的：
 *   * 两条频控（规格第 22-25 行）—— 键名与 `RATE_LIMIT_RULES[].specKey` 逐字一致；
 *   * 自动发现的两项（每轮上限、每日开关）。
 * 尚未接上的（如实记在这里，别让人以为改了就生效）：媒体限额（单张大小 / 每篇张数）、
 * 草稿自动保存间隔、内容筛查开关 —— 见 docs/HANDOFF.md。
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'rate_limits.comment_changes_per_minute',
    label: '评论变更频率上限',
    description: '新评论、回复、正文修改**合并计数**（参数与管理规则.md 第 24 行）。',
    kind: 'integer',
    defaultValue: 5,
    min: 1,
    max: 60,
    unit: '次/分/用户',
  },
  {
    key: 'rate_limits.plugin_submissions_per_hour',
    label: '插件提交检查上限',
    description: '每个用户每小时最多发起多少次**新的**指定插件提交检查（参数与管理规则.md 第 25 行）。',
    kind: 'integer',
    defaultValue: 10,
    min: 1,
    max: 200,
    unit: '次/时/用户',
  },
  {
    key: 'rate_limits.reports_per_hour',
    label: '举报提交上限',
    description: '每个用户每小时最多提交多少次举报（`idea.md §20` 互动三件套之一）。',
    kind: 'integer',
    defaultValue: 20,
    min: 1,
    max: 200,
    unit: '次/时/用户',
  },
  {
    key: 'rate_limits.corrections_per_hour',
    label: '资料纠错提交上限',
    description: '每个用户每小时最多提交多少次插件资料纠错（idea.md §2 / §23）。',
    kind: 'integer',
    defaultValue: 10,
    min: 1,
    max: 200,
    unit: '次/时/用户',
  },
  {
    key: 'discovery.max_plugins_per_run',
    label: '自动发现每轮收录上限',
    description:
      '一轮自动发现最多收录多少个插件。注意上游配额：服务器没配 GitHub token 时核心接口只有 60 次/小时，会再被预算收紧。',
    kind: 'integer',
    defaultValue: 30,
    min: 1,
    max: 200,
    unit: '个/轮',
  },
  {
    key: 'discovery.daily_enabled',
    label: '每日自动发现',
    description: '关掉后 worker 不再排入每天的发现任务（手动「立即发现」不受影响）。',
    kind: 'boolean',
    defaultValue: true,
  },
];

export type SettingValue = number | boolean;
export type EffectiveSettings = Record<string, SettingValue>;

export interface SettingsRevisionView {
  revisionId: string;
  revisionNumber: number;
  reason: string;
  changes: unknown;
  snapshot: EffectiveSettings;
  changedBy: string | null;
  changedByName: string | null;
  createdAt: number;
}

export interface SettingsReadModel {
  /** 当前生效值（默认值 + 库内覆盖）。 */
  effective: EffectiveSettings;
  /** 定义清单（后台表单据此渲染标签、范围与默认值）。 */
  definitions: readonly SettingDefinition[];
  /** 库里存在但**不在定义清单**里的键（有人手改过库时才会非空）。 */
  unknownKeys: string[];
  /** 被覆盖过的键（= 库里真有行），便于后台标出"改过的项"。 */
  overriddenKeys: string[];
}

export interface SettingsService {
  read(): Promise<SettingsReadModel>;
  history(limit?: number): Promise<SettingsRevisionView[]>;
  update(
    ctx: CallerContext,
    input: { changes: Record<string, unknown>; reason: string; requestKey: string },
  ): Promise<{ revisionId: string | null; revisionNumber: number | null; effective: EffectiveSettings; applied: Array<{ key: string; from: SettingValue; to: SettingValue }> }>;
}

/** 定义表按 key 索引。 */
export const SETTING_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((d) => [d.key, d]),
);

/** 校验并规范化一个设置值；类型/范围不对就抛输入错误（带字段路径，前端能直接标红）。 */
export function parseSettingValue(def: SettingDefinition, raw: unknown): SettingValue {
  if (def.kind === 'boolean') {
    if (typeof raw !== 'boolean') {
      throw err.input(`${def.label} 必须是 true 或 false。`, [{ path: def.key, message: '类型不合法' }]);
    }
    return raw;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw err.input(`${def.label} 必须是整数。`, [{ path: def.key, message: '类型不合法' }]);
  }
  if (def.min !== undefined && raw < def.min) {
    throw err.input(`${def.label} 不能小于 ${def.min}${def.unit ?? ''}。`, [{ path: def.key, message: `最小 ${def.min}` }]);
  }
  if (def.max !== undefined && raw > def.max) {
    throw err.input(`${def.label} 不能大于 ${def.max}${def.unit ?? ''}。`, [{ path: def.key, message: `最大 ${def.max}` }]);
  }
  return raw;
}

/** 读当前生效值（不校验库里的值：库里若不是我们写的，读取阶段不该让整站挂掉）。 */
export function effectiveSettings(db: SqliteDatabase): SettingsReadModel {
  const rows = db.prepare('SELECT key, value FROM site_settings').all() as Array<{ key: string; value: string }>;
  const stored = new Map<string, unknown>();
  for (const row of rows) {
    try {
      stored.set(row.key, JSON.parse(row.value));
    } catch {
      // json_valid CHECK 保证这里进不来；真进来了也只是"这个键按默认值走"。
    }
  }

  const effective: EffectiveSettings = {};
  const overriddenKeys: string[] = [];
  for (const def of SETTING_DEFINITIONS) {
    const raw = stored.get(def.key);
    if (raw === undefined) {
      effective[def.key] = def.defaultValue;
      continue;
    }
    try {
      effective[def.key] = def.kind === 'boolean' ? raw === true : Number(raw);
      overriddenKeys.push(def.key);
    } catch {
      effective[def.key] = def.defaultValue;
    }
  }

  const unknownKeys = [...stored.keys()].filter((k) => !SETTING_BY_KEY.has(k)).sort();
  return { effective, definitions: SETTING_DEFINITIONS, unknownKeys, overriddenKeys };
}

export function createSettingsService(deps: { db: SqliteDatabase }): SettingsService {
  const { db } = deps;

  return {
    async read() {
      return effectiveSettings(db);
    },

    async history(limit = 20) {
      const capped = Math.min(Math.max(limit, 1), 100);
      const rows = db
        .prepare(
          `SELECT r.id, r.revision_number, r.reason, r.changes, r.effective_snapshot, r.changed_by, r.created_at,
                  u.nickname AS changed_by_name
             FROM configuration_revisions r
             LEFT JOIN users u ON u.id = r.changed_by
            ORDER BY r.revision_number DESC
            LIMIT ?`,
        )
        .all(capped) as Array<{
        id: string;
        revision_number: number;
        reason: string;
        changes: string;
        effective_snapshot: string;
        changed_by: string | null;
        changed_at?: number;
        created_at: number;
        changed_by_name: string | null;
      }>;
      return rows.map((r) => ({
        revisionId: r.id,
        revisionNumber: r.revision_number,
        reason: r.reason,
        changes: safeJson(r.changes),
        snapshot: (safeJson(r.effective_snapshot) ?? {}) as EffectiveSettings,
        changedBy: r.changed_by,
        changedByName: r.changed_by_name,
        createdAt: r.created_at,
      }));
    },

    async update(ctx, input) {
      // 只有管理员能改业务参数（规格：常用项后台可调，但改的人得是管理员）。
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以修改业务配置。');
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length === 0) throw err.input('修改配置必须填原因。', [{ path: 'reason', message: '必填' }]);
      if (typeof input.requestKey !== 'string' || input.requestKey.trim().length === 0) {
        throw err.input('缺少请求标识。', [{ path: 'request_key', message: '必填' }]);
      }
      const changes = input.changes ?? {};
      const keys = Object.keys(changes);
      if (keys.length === 0) throw err.input('没有要修改的项。', [{ path: 'changes', message: '不能为空' }]);
      for (const key of keys) {
        if (!SETTING_BY_KEY.has(key)) {
          throw err.input(`不认识的配置项：${key}。`, [{ path: key, message: '不在可配置清单里' }]);
        }
      }

      const now = Date.now();
      return db.transaction(() => {
        const current = effectiveSettings(db);
        const applied: Array<{ key: string; from: SettingValue; to: SettingValue }> = [];
        const nextValues: Record<string, SettingValue> = {};

        for (const key of keys) {
          const def = SETTING_BY_KEY.get(key) as SettingDefinition;
          const to = parseSettingValue(def, changes[key]);
          const from = current.effective[key] as SettingValue;
          if (from === to) continue; // 与现状相同 → 不算一次变更（幂等靠它，不靠请求键）
          applied.push({ key, from, to });
          nextValues[key] = to;
        }

        if (applied.length === 0) {
          return { revisionId: null, revisionNumber: null, effective: current.effective, applied };
        }

        const effectiveAfter: EffectiveSettings = { ...current.effective, ...nextValues };
        const nextNumber =
          (
            db
              .prepare('SELECT COALESCE(MAX(revision_number), 0) AS n FROM configuration_revisions')
              .get() as { n: number }
          ).n + 1;
        const revisionId = newId(now);

        db.prepare(
          `INSERT INTO configuration_revisions
             (id, revision_number, definition_version, effective_snapshot, changes, reason, changed_by, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          revisionId,
          nextNumber,
          JSON.stringify(effectiveAfter),
          JSON.stringify({ changes: applied }),
          reason,
          ctx.userId,
          now,
        );

        const upsert = db.prepare(
          `INSERT INTO site_settings (key, value, changed_in_revision_id, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value,
             changed_in_revision_id = excluded.changed_in_revision_id,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        );
        for (const item of applied) {
          upsert.run(item.key, JSON.stringify(item.to), revisionId, ctx.userId, now);
        }

        return { revisionId, revisionNumber: nextNumber, effective: effectiveAfter, applied };
      })();
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 频控的覆盖参数（给 `enforceRateLimit` 用）。
 *
 * 键名取自规则的 `specKey`，与 `SETTING_DEFINITIONS` 里的键逐字一致 ——
 * 两处不会各写各的（这条是防漂移的关键：改了这边忘了那边，就成了"配置项摆设"）。
 */
export async function rateLimitOverrideFor(
  db: SqliteDatabase,
  rule: { specKey: string; points: number },
): Promise<{ points: number }> {
  const model = effectiveSettings(db);
  const value = model.effective[rule.specKey];
  return {
    points: typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : rule.points,
  };
}

/** 自动发现的两项配置（供 worker 的排程与处理器读取）。 */
export function discoverySettingsFrom(db: SqliteDatabase): { dailyEnabled: boolean; maxPluginsPerRun: number } {
  const model = effectiveSettings(db);
  const enabled = model.effective['discovery.daily_enabled'];
  const maxPlugins = model.effective['discovery.max_plugins_per_run'];
  return {
    dailyEnabled: enabled !== false,
    maxPluginsPerRun:
      typeof maxPlugins === 'number' && Number.isInteger(maxPlugins) && maxPlugins > 0 ? maxPlugins : 30,
  };
}
