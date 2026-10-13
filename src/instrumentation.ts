/**
 * Next 启动钩子与**服务端未捕获异常**钩子（Next 15+ 的原生机制）。
 *
 * 解决两个此前看不见的洞：
 *  1) 服务起没起、起的是哪份代码、库结构对不对 —— 容器里这是第一句要问的话；
 *  2) Server Component / 路由处理器里**未被捕获**的异常 —— 以前只有 API 层
 *     `errorResponse` 那条路径会记日志，页面渲染炸掉时服务端可能一个字都没有，
 *     用户看到的是英文白页，两边都抓瞎。
 *
 * 用户能在错误页上看到 `digest`，日志里记的是同一个 `digest` ——
 * "用户报一个号 → 日志里定位到那一次渲染"这条链路才真的闭合。
 *
 * ⚠️ 本文件会被编译到 **Edge 运行时**（Next 的默认行为），所以这里**不能**
 * 出现任何 Node 专有 API 或业务模块：真正的实现在 `instrumentation-node.ts`，
 * 用文档推荐的"正条件 + 动态引入"形式挡在 node 侧。
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mod = await import('./instrumentation-node');
    await mod.registerNodeRuntime();
  }
}

/** 服务端未捕获异常的钩子，签名由 Next 固定：`InstrumentationOnRequestError`。 */
export async function onRequestError(
  error: unknown,
  request: Readonly<{ path: string; method: string; headers: NodeJS.Dict<string | string[]> }>,
  context: Readonly<{ routerKind: string; routePath: string; routeType: string; renderSource?: string }>,
): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mod = await import('./instrumentation-node');
    await mod.logRequestError(error, request, context);
  }
}
