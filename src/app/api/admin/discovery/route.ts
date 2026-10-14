/**
 * 目录自动发现的后台入口（`idea.md §1`：管理员"立即同步"按钮；§23 后台"任务与同步"组）。
 *
 * GET  /api/admin/discovery   最近几轮发现的结果（读的是任务的 progress 列）+ 每日排程现状
 * POST /api/admin/discovery   { requestKey, maxPlugins? } 立即排一轮发现
 *
 * 为什么是"排任务"而不是同步跑：真正的执行在 worker 里（租约、重试、可见的 progress），
 * 这条路与每天定时那一轮**完全同一条路径** —— 后台按钮不该有第二套实现。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createTasksService } from '@/server/modules/tasks/service';
import { createSettingsService, discoverySettingsFrom } from '@/server/modules/settings';
import { DISCOVERY_DEFAULTS, discoveryBudgetFor } from '@/server/modules/catalog/discovery';
import { DISCOVERY_SCHEDULING_GROUP } from '@/worker/scheduled';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, deduplication_key, processing_state, attempt_count,
                last_error_code, last_error_summary, progress, created_at, finished_at
           FROM background_tasks
          WHERE task_type = 'plugin_discovery'
          ORDER BY created_at DESC, id DESC
          LIMIT 10`,
      )
      .all() as Array<{
      id: string;
      deduplication_key: string;
      processing_state: string;
      attempt_count: number;
      last_error_code: string | null;
      last_error_summary: string | null;
      progress: string;
      created_at: number;
      finished_at: number | null;
    }>;

    const settings = createSettingsService({ db });
    const model = await settings.read();
    const budget = discoveryBudgetFor(process.env);
    const config = discoverySettingsFrom(db);

    return okJson(
      {
        runs: rows.map((r) => ({
          taskId: r.id,
          deduplicationKey: r.deduplication_key,
          state: r.processing_state,
          attempts: r.attempt_count,
          lastErrorCode: r.last_error_code,
          lastErrorSummary: r.last_error_summary,
          summary: safeJson(r.progress),
          createdAt: r.created_at,
          finishedAt: r.finished_at,
        })),
        config: {
          dailyEnabled: config.dailyEnabled,
          maxPluginsPerRun: config.maxPluginsPerRun,
          // 实际会用到的预算（配置与上游配额取更小者），让管理员看得见"为什么只有这么几条"
          effectiveMaxPlugins: Math.min(budget.maxPlugins, config.maxPluginsPerRun),
          authenticated: (process.env.GITHUB_TOKEN ?? '').trim().length > 0,
          maxRequests: budget.maxRequests,
          query: DISCOVERY_DEFAULTS.query,
        },
        settingsUnknownKeys: model.unknownKeys,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const body = (await readJson(request)) as { requestKey?: unknown; maxPlugins?: unknown };
    if (typeof body.requestKey !== 'string' || body.requestKey.trim().length === 0) {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }

    const db = getDb();
    const budget = discoveryBudgetFor(process.env);
    const config = discoverySettingsFrom(db);
    let maxPlugins = Math.min(budget.maxPlugins, config.maxPluginsPerRun);
    if (typeof body.maxPlugins === 'number') {
      if (!Number.isInteger(body.maxPlugins) || body.maxPlugins < 1 || body.maxPlugins > 200) {
        throw err.input('maxPlugins 必须是 1..200 的整数。', [{ path: 'maxPlugins', message: '取值不合法' }]);
      }
      maxPlugins = Math.min(body.maxPlugins, budget.maxPlugins);
    }

    // 幂等：同一个 requestKey 排出来的还是同一个任务（手动一轮的键 = manual:<requestKey>）。
    const runKey = `manual:${body.requestKey.trim()}`;
    const tasks = createTasksService(db);
    const { taskId, created } = await tasks.enqueue({
      taskType: 'plugin_discovery',
      deduplicationKey: runKey,
      requestedBy: ctx.userId,
      payload: {
        run_key: runKey,
        query: DISCOVERY_DEFAULTS.query,
        search_pages: budget.searchPages,
        per_page: budget.perPage,
        max_candidates: budget.maxCandidates,
        max_plugins: maxPlugins,
        max_requests: budget.maxRequests,
      },
      schedulingGroup: DISCOVERY_SCHEDULING_GROUP,
      availableAt: Date.now(),
    });

    return okJson({ taskId, created, maxPlugins }, requestId, 202);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
