/**
 * 前端共用的接口调用与错误呈现工具。
 *
 * 三条硬规则（来自接口层契约）：
 *  1. 响应统一是 `{ ok: true, data, request_id }` 或 `{ ok: false, error, request_id }`，
 *     所以**必须先看 `ok`**，不能只看 HTTP 状态码；
 *  2. 失败时把后端 `error.message` **原样**交给界面显示，不吞、不改写；
 *     流程判断用稳定的 `error.code`，绝不匹配中文提示；
 *  3. `request_key` 是"这次用户操作的幂等键"：一次操作生成一个，重试复用同一个，
 *     不能每次 fetch 都新生成（否则重试会重复建草稿）。
 */

import type { BusinessError, FieldError } from '@/packages/common/errors';

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  request_id: string;
}

export interface ApiFailure {
  ok: false;
  error: BusinessError;
  request_id: string;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

/** 调用 API 失败时抛出的错误：携带后端原始 message 与稳定 code。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: BusinessError['fields'];
  /**
   * 后端附带的机器可读上下文（例如频控的 `retry_after_seconds`）。
   *
   * 此前这里把它丢掉了 —— 后端明明算好了"还要等几秒"（`rate-limit.ts` 写入
   * `context.retry_after_seconds`），界面却只能说一句"操作失败"，用户无从知道等多久。
   * 现在原样保留，由界面按需使用（不参与流程判断：流程判断仍然只看 `code`）。
   */
  readonly context?: Record<string, string | number | boolean | null>;

  constructor(error: BusinessError, status: number) {
    // 原样保留后端 message —— 界面直接显示这句话，不做二次加工。
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.status = status;
    this.fields = error.fields;
    this.context = error.context;
  }

  /** 被频控时服务端给出的等待秒数（没有就是 null）。 */
  retryAfterSeconds(): number | null {
    const raw = this.context?.['retry_after_seconds'];
    return typeof raw === 'number' && raw > 0 ? raw : null;
  }

  /** 把字段级错误拼成一行可读提示（后端已给出稳定字段路径）。 */
  describeFields(): string | null {
    if (!this.fields || this.fields.length === 0) return null;
    return this.fields.map((f: FieldError) => `${f.path}：${f.message}`).join('；');
  }
}

/**
 * 发起一次 JSON 接口调用。
 *
 * 网络层失败（服务器没起来、断网）也会折成 ApiError，
 * 这样界面只有**一种**错误呈现路径，不会出现"有的错显示、有的错静默"。
 */
export async function apiFetch<T>(
  input: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  let body = rest.body;
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }

  let response: Response;
  try {
    response = await fetch(input, { ...rest, headers, body });
  } catch (e) {
    throw new ApiError(
      {
        code: 'internal',
        message: `无法连接服务器：${e instanceof Error ? e.message : String(e)}`,
      },
      0,
    );
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(
      { code: 'internal', message: `服务器返回了无法解析的响应（HTTP ${response.status}）。` },
      response.status,
    );
  }

  if (!envelope.ok) throw new ApiError(envelope.error, response.status);
  return envelope.data;
}

/** 每次用户操作生成一个幂等键；同一次操作的重试必须复用它。 */
export function newRequestKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 老浏览器兜底（不引第三方依赖）。
  return `rk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 统一的错误提示条（失败=红系；语义与"警告/提示"分开）。 */
export function ErrorNotice({ error, onDismiss }: { error: ApiError; onDismiss?: () => void }) {
  const fields = error.describeFields();
  // 频控是**可解释**的失败：服务端已经算好还要等几秒，就必须说出来，
  // 否则用户只会反复点、反复失败（`docs/验收纪律.md`：不装作成功，也不隐瞒原因）。
  const waitSeconds = error.retryAfterSeconds();
  return (
    <div
      role="alert"
      className="notice danger"
      style={{
        margin: '12px 0',
        fontSize: 14,
      }}
    >
      <div>
        <strong>操作失败</strong>（<code>{error.code}</code>）：{error.message}
      </div>
      {waitSeconds !== null ? (
        <div style={{ marginTop: 4 }}>建议等待约 {waitSeconds} 秒后重试（服务端给出的等待时长）。</div>
      ) : null}
      {fields ? <div style={{ marginTop: 4 }}>字段问题：{fields}</div> : null}
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="link-btn danger" style={{ marginTop: 6 }}>
          知道了
        </button>
      ) : null}
    </div>
  );
}

/** 成功提示条（成功=绿系）。 */
export function SuccessNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="notice success"
      style={{
        margin: '12px 0',
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

export const buttonStyle: React.CSSProperties = {
  background: 'var(--accent)',
  color: 'var(--on-primary)',
  border: 'none',
  borderRadius: 6,
  padding: '8px 14px',
  cursor: 'pointer',
  fontSize: 14,
};

export const secondaryButtonStyle: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 6,
  padding: '8px 14px',
  cursor: 'pointer',
  fontSize: 14,
};

export const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--line-strong)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 15,
  fontFamily: 'inherit',
};
