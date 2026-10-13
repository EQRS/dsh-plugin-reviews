/**
 * 启动钩子与请求错误钩子的**真正实现**（只在 nodejs 运行时被动态引入）。
 *
 * 拆成独立文件的原因：`instrumentation.ts` 会被 Next 同时编译到 **Edge 运行时**，
 * 而 edge 里没有 `process.stdout`、更没有 better-sqlite3 —— 放在同一个文件里会
 * 让构建报一堆 "A Node.js API is used ... not supported in the Edge Runtime" 警告。
 * 这里用"正条件判断 + 动态引入"的文档写法把它挡在 node 侧。
 */

export async function registerNodeRuntime(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { log } = await import('@/server/platform/log');
  log.info('服务启动', {
    node: process.version,
    env: process.env.NODE_ENV ?? 'unknown',
    pid: process.pid,
  });

  try {
    const { getDb } = await import('@/server/platform/db');
    const { selfCheck } = await import('@/server/platform/migrate');
    const check = selfCheck(getDb());
    log.info('启动自检', {
      schema_version: check.schemaVersion,
      foreign_keys: check.foreignKeys,
      journal_mode: check.journalMode,
      missing_tables: check.missingTables.length,
    });
    if (check.problems.length > 0) {
      // 刻意**不**在这里退出进程：库没迁完时反复重启只会更难查；
      // /api/health 会返回 503、容器健康检查与诊断脚本都会报，足够被发现。
      log.error('启动自检未通过', { problems: check.problems.join('；') });
    }
  } catch (e) {
    log.error('启动自检失败', { error: e instanceof Error ? e.message : String(e) });
  }
}

export async function logRequestError(
  error: unknown,
  request: Readonly<{ path: string; method: string; headers: NodeJS.Dict<string | string[]> }>,
  context: Readonly<{ routerKind: string; routePath: string; routeType: string; renderSource?: string }>,
): Promise<void> {
  const { log } = await import('@/server/platform/log');
  const inboundId = request.headers?.['x-request-id'];
  const requestId = (Array.isArray(inboundId) ? inboundId[0] : inboundId) ?? null;
  const digest = (error as { digest?: unknown } | undefined)?.digest;

  log.error('request_error', {
    request_id: requestId,
    method: request.method,
    path: request.path,
    route_path: context.routePath,
    route_type: context.routeType,
    router_kind: context.routerKind,
    render_source: context.renderSource ?? null,
    // 这个 digest 与用户在错误页上看到的是同一个（Next 只在生产给）
    digest: typeof digest === 'string' ? digest : null,
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });
}
