/**
 * 结构化日志（依赖与 Linux 部署第 8 节）。
 *
 * 规则：结构化 stdout；包含 request/task ID 与受限错误码；
 * **不记录凭据、会话 token、私有正文或第三方原始响应**。
 */

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

function emit(level: 'info' | 'warn' | 'error', message: string, fields?: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ?? {}),
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** 敏感键名黑名单：命中即替换为 [redacted]，避免误记凭据。 */
const SENSITIVE_KEYS = /token|secret|password|credential|authorization|cookie|code_verifier/i;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : v;
  }
  return out;
}

export const log = {
  info: (message: string, fields?: LogFields) => emit('info', message, fields ? redact(fields) : undefined),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields ? redact(fields) : undefined),
  error: (message: string, fields?: LogFields) => emit('error', message, fields ? redact(fields) : undefined),
};
