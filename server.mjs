/**
 * 生产服务器入口（替代 `next start`）—— **只为可观测性**，不改变任何业务行为。
 *
 * 为什么需要它：Next 16 的 `logging.incomingRequests` **只在 dev 生效**（实测生产下不出一行），
 * 而中间件（`middleware`）拿不到最终状态码 —— 于是"哪个接口 500 了、哪个页面慢、
 * 404 是不是变多了"在生产日志里根本无从看起。自定义 server 是拿到**每请求一行、
 * 含状态码与耗时**的标准做法（也是将来放反代之前能自己做的最完整方案）。
 *
 * 一行一条 JSON，字段：request_id / method / path / status / duration_ms / slow。
 * 与业务日志共用同一个 `request_id`（复用入站 `x-request-id`，否则自己生成），
 * 所以从用户报的编号能直接 grep 到这一行的上下文。
 *
 * 静音规则：静态资源与健康检查不打（量最大、信息量最小，会把日志淹掉）。
 *
 * 环境变量：
 *   PORT                        监听端口（默认 3000）
 *   DSH_REVIEW_HOST             绑定地址（默认 0.0.0.0）
 *   DSH_REVIEW_SLOW_REQUEST_MS  慢请求阈值（默认 1000；超过就打 slow:true，且升为 warn）
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import next from 'next';

const port = Number(process.env.PORT ?? 3000);
// 注意：不要用 HOSTNAME —— 容器里它被 Docker 设成容器 ID，不是绑定地址。
const hostname = process.env.DSH_REVIEW_HOST ?? '0.0.0.0';
const slowMs = Number(process.env.DSH_REVIEW_SLOW_REQUEST_MS ?? 1000);

/** 这些路径不打访问日志（静态资源按前缀，健康检查按路径）。 */
function isQuiet(path) {
  return path.startsWith('/_next/') || path === '/api/health' || path === '/favicon.ico';
}

function writeLine(level, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message: 'http_request', ...fields });
  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  const startedAt = Date.now();
  const path = (req.url ?? '/').split('?')[0];
  const inboundId = req.headers['x-request-id'];
  const requestId = (Array.isArray(inboundId) ? inboundId[0] : inboundId) || randomUUID();

  // 关键一步：把 id **注入到入站请求头**，业务层（requestIdFromHeaders）就会沿用它。
  // 不注入的话业务层会自己再生成一个 —— 于是"响应体里的 request_id"与"访问日志里的
  // request_id"是两个号，用户报编号时根本 grep 不到那一行（实测踩过）。
  if (!req.headers['x-request-id']) req.headers['x-request-id'] = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    if (isQuiet(path)) return;
    const durationMs = Date.now() - startedAt;
    const status = res.statusCode;
    const slow = durationMs >= slowMs;
    writeLine(status >= 500 || slow ? 'warn' : 'info', {
      request_id: requestId,
      method: req.method ?? 'GET',
      path,
      status,
      duration_ms: durationMs,
      slow,
    });
  });

  handle(req, res);
});

server.listen(port, hostname, () => {
  writeLine('info', { message: 'server_listening', port, hostname, slow_request_ms: slowMs });
});

/** 优雅退出：容器里靠 tini 把 SIGTERM 送到这里。 */
let closing = false;
const shutdown = (signal) => {
  if (closing) return;
  closing = true;
  writeLine('info', { message: 'server_shutdown_start', signal });
  server.close(() => {
    writeLine('info', { message: 'server_shutdown_done' });
    process.exitCode = 0;
  });
  // 兜底：连接迟迟不关也不能永远挂着（容器 stop 有超时，超时会被 SIGKILL）
  setTimeout(() => {
    writeLine('warn', { message: 'server_shutdown_timeout' });
    process.exitCode = 0;
  }, 10_000).unref?.();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
