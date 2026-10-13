/**
 * `GET /api/health` —— 存活/就绪检查（容器 HEALTHCHECK、负载均衡、运维诊断）。
 *
 * 契约（**有意偏离业务接口的信封约定**，在这里说清楚）：
 *  - 业务接口用 `{ok, data|error, request_id}` 且靠 HTTP 状态码表达结果；
 *    健康检查反过来 —— 它**总是**返回 `{ok:true, data:<报告>}`，
 *    由 **HTTP 状态码**表达结论（200 = 可用于继续服务 / 503 = 结构性故障）。
 *    理由：健康检查的读者是编排器和 curl，它们只看状态码；让 body 的语义与状态码
 *    互相打架（ok:false 却 200）只会让两边都难写。
 *  - 公网可见的 body 只有 `status / checked_at / schema_version`；
 *    完整报告（逐项检查、磁盘余量、worker 心跳）需要 `?detail=1` **且**带上
 *    `x-health-token` 等于 `DSH_REVIEW_HEALTH_TOKEN`。该变量未配置时 detail 一律不下发。
 *  - `?worker=1` 把 worker 心跳算进结论：worker 卡死时本端点返回 503。
 *    默认**不算** —— web 的存活检查不该因为 worker 挂了而被编排器重启。
 */

import { getDb, resolveDbPath } from '@/server/platform/db';
import { buildHealthReport, statusForHealth } from '@/server/platform/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isDetailAllowed(request: Request, url: URL): boolean {
  if (url.searchParams.get('detail') !== '1') return false;
  const expected = process.env.DSH_REVIEW_HEALTH_TOKEN;
  if (!expected || expected.length < 16) return false;
  return request.headers.get('x-health-token') === expected;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requireWorker = url.searchParams.get('worker') === '1';
  const detailAllowed = isDetailAllowed(request, url);

  const report = buildHealthReport(getDb(), {
    now: Date.now(),
    dbFile: resolveDbPath(process.env.DSH_REVIEW_DB_PATH),
    requireWorker,
  });

  const body = detailAllowed
    ? { ok: true, data: report }
    : {
        ok: true,
        data: {
          status: report.status,
          checked_at: report.checked_at,
          schema_version: report.schema_version,
        },
      };

  return new Response(JSON.stringify(body), {
    status: statusForHealth(report),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
