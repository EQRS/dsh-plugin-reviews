/**
 * 插件目录接口（架构第 88 节）。
 *
 * GET  /api/plugins          公开列表（分页）
 * POST /api/plugins          收录一个插件（需登录；收录检查经 GitHub 探针）
 *
 * 收录检查探针：`@/server/adapters/catalog/github-probe` 的真实 api.github.com 实现。
 * 需要离线/CI 时设 `DSH_REVIEW_CATALOG_OFFLINE=1`，探针会抛 provider_not_configured（→503），
 * **绝不假装收录成功**。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createCatalogService } from '@/server/modules/catalog';
import { createGithubCatalogProbe } from '@/server/adapters/catalog/github-probe';
import { err } from '@/packages/common/errors';
import { PaginationDefaults } from '@/packages/common/result';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('page_size') ?? String(PaginationDefaults.default_page_size));

    if (!Number.isInteger(page) || page < 1) {
      throw err.input('页码必须是从 1 开始的正整数。', [{ path: 'page', message: '取值不合法' }]);
    }
    if (!(PaginationDefaults.allowed_page_sizes as readonly number[]).includes(pageSize)) {
      throw err.input(
        `每页条数只允许 ${PaginationDefaults.allowed_page_sizes.join('、')}。`,
        [{ path: 'page_size', message: '取值不合法' }],
      );
    }

    const catalog = createCatalogService({ db: getDb() });
    const result = await catalog.listPlugins({ page, page_size: pageSize });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { url?: unknown; requestKey?: unknown };
    if (typeof body.url !== 'string' || typeof body.requestKey !== 'string') {
      throw err.input('缺少仓库链接或请求标识。', [
        { path: 'url', message: '必填' },
        { path: 'requestKey', message: '必填' },
      ]);
    }

    const db = getDb();

    // 频控必须落在"出网探测 GitHub"**之前**（参数与管理规则.md 第 25 行：每小时 10 次新提交检查）：
    // 否则超限的用户仍然能让我们替他打满上游额度。
    // assertCanWrite 自己会把匿名/停用账户挡掉（业务层同样会拒，这里是前置，顺便收窄类型）。
    assertCanWrite(ctx);
    const ticket = await enforceRateLimit(
      db,
      'plugin_submission',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.plugin_submission),
    );

    // 真实 GitHub 探针：仓库可访问 + package.json 声明 dsh.bundle + 引用文件存在，三项都过才收录。
    // 探针在事务外调用（better-sqlite3 是同步驱动，事务内出网会长时间持锁）。
    const probe = createGithubCatalogProbe();
    const catalog = createCatalogService({ db });
    try {
      const result = await catalog.acceptPluginSubmission(
        ctx,
        { url: body.url, requestKey: body.requestKey },
        { probe },
      );
      // 幂等重放 = 本次没有产生新的收录检查 → 退还额度（规格：重放不另算一次提交）。
      if (result.replayed) await refundQuietly(ticket);
      // 201：本次收录请求已成功处理（created=false 表示命中既有记录，同样算成功而不是 200/409）。
      return okJson(result, requestId, 201);
    } catch (e) {
      // 失败 = 没有产生任何变更。规格把"无效输入防护"划给独立的请求层，
      // 不用业务计数冒充全局限流，所以这里把额度还回去。
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
