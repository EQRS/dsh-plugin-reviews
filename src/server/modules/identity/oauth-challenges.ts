/**
 * GitHub OAuth 短期挑战（架构第 11 节、依赖与部署第 5 节）。
 *
 * 职责：把"用户点了登录"到"回调带着 code 回来"之间的**临时上下文**持久化，
 * 使登录不依赖 Web 进程内存（重启后用户不必重新开始，也不会误判已登录）。
 *
 * 铁律：
 *  1. state 与浏览器绑定**只存摘要**，不存原值；
 *  2. 挑战是**一次性**的：消费后立刻标记 consumed_at，重放直接拒绝；
 *  3. 过期拒绝；消费与建会话在同一事务语义内完成（由回调路由协调）；
 *  4. `return_path` 只允许站内相对路径（数据库层已有 CHECK 兜底）。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { withTransaction, type Tx } from '@/server/platform/tx';
import { nowMs } from '@/server/platform/time';
import { newId, newOpaqueToken } from '@/server/platform/id';
import { digestText } from '@/server/platform/digest';
import { err } from '@/packages/common/errors';

/** 挑战有效期（架构第 109 节：默认 600 秒）。 */
export const CHALLENGE_TTL_MS = 600 * 1000;
/** 浏览器绑定 cookie 名（只用于临时绑定，不代表已登录）。 */
export const BROWSER_BINDING_COOKIE = 'dsh_oauth_binding';

export interface CreatedChallenge {
  challengeId: string;
  /** 交给 GitHub 的 state 原值（只在这里出现一次）。 */
  state: string;
  /** 写入浏览器的绑定原值（只在这里出现一次）。 */
  browserBinding: string;
  /** 参与 PKCE 的 code_verifier（回调时要用）。 */
  codeVerifier: string;
  codeChallenge: string;
  authorizeUrlState: string;
}

export interface ConsumedChallenge {
  challengeId: string;
  codeVerifier: string;
  returnPath: string;
}

/** PKCE S256：base64url(sha256(verifier))，无填充。 */
export function codeChallengeFromVerifier(verifier: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * 规范化回跳路径：只接受站内相对路径，其余一律回到首页。
 *
 * 黑名单式校验不够：在 WHATWG URL 解析下，反斜杠在 http(s) 这类 special scheme
 * 中等价于斜杠 —— `\/\evil.example`（或解码后的 `/\evil.example`）会被浏览器
 * 解析成 `//evil.example`（协议相对地址），构成开放重定向；ASCII 制表符/控制字符
 * 也可能被解析器忽略或用于截断。因此这里以**解析器**为准：把候选拼到固定 base
 * 上解析，origin 必须仍是 base 本身；同时显式拒绝反斜杠与 C0 控制字符（不依赖
 * 解析器版本差异）。
 */
export function normalizeReturnPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '/';
  const trimmed = raw.trim();
  if (trimmed === '' || !trimmed.startsWith('/')) return '/';
  // 协议相对地址（//evil.example）与反斜杠变体（/\evil.example）都不是站内路径。
  // 反斜杠在浏览器 URL 解析中等价于斜杠，`//` 与 `/\` 必须同判。
  if (trimmed.startsWith('//') || trimmed.includes('\\')) return '/';
  // 控制字符（CR/LF/TAB 等）不得进入回跳路径：拒绝而非静默剔除，
  // 避免「剔除后恰好拼出别的地址」这类二次构造。
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '/';
  // 解析器兜底：拼到固定站内 base 上，origin 必须仍是 base 本身。
  try {
    const resolved = new URL(trimmed, 'http://dsh.invalid');
    if (resolved.origin !== 'http://dsh.invalid') return '/';
  } catch {
    return '/';
  }
  return trimmed;
}

/**
 * verifier 信封。
 *
 * 诚实说明：本切片把 verifier 以**明文 JSON 信封**保存（含算法与版本标记），
 * 因为部署密钥体系尚未接入。这不改变"state/绑定只存摘要"的性质，
 * 但**生产环境必须**换成部署密钥加密后才可视为满足架构第 109 节的要求。
 * 未配置密钥时，服务端拒绝在生产环境发起登录（见 assertChallengeStorageAllowed）。
 */
export interface VerifierEnvelope {
  alg: 'none';
  v: 1;
  verifier: string;
}

export function encodeVerifier(verifier: string): string {
  return JSON.stringify({ alg: 'none', v: 1, verifier } satisfies VerifierEnvelope);
}

export function decodeVerifier(envelope: string): string {
  const parsed = JSON.parse(envelope) as Partial<VerifierEnvelope>;
  if (parsed.v !== 1 || typeof parsed.verifier !== 'string' || parsed.verifier.length === 0) {
    throw err.internal('登录挑战的 verifier 信封损坏。');
  }
  return parsed.verifier;
}

/**
 * 生产环境需要部署密钥才能安全保存 verifier。
 * 未配置时**明确拒绝**，而不是悄悄用明文存进生产库。
 */
export function assertChallengeStorageAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (!env.SESSION_SECRET || env.SESSION_SECRET.trim().length < 32) {
    throw err.notConfigured(
      '生产环境未配置 SESSION_SECRET（至少 32 字节），无法安全保存登录挑战。已拒绝发起登录。',
    );
  }
}

export interface OAuthChallengeService {
  create(input: { returnPath: string }): CreatedChallenge;
  /**
   * 消费挑战：核验 state + 浏览器绑定 + 未过期 + 未消费。
   * 成功后**原子标记 consumed_at** 并返回 verifier；任一条件不满足即拒绝。
   */
  consume(input: { state: string; browserBinding: string }): ConsumedChallenge;
}

interface ChallengeRow {
  id: string;
  state_digest: string;
  browser_binding_digest: string;
  code_verifier_envelope: string;
  return_path: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export function createOAuthChallengeService(db: SqliteDatabase): OAuthChallengeService {
  return {
    create(input) {
      assertChallengeStorageAllowed();

      const state = newOpaqueToken();
      const browserBinding = newOpaqueToken();
      const codeVerifier = newOpaqueToken();
      const id = newId();
      const now = nowMs();
      const returnPath = normalizeReturnPath(input.returnPath);

      withTransaction((tx: Tx) => {
        tx.db
          .prepare(
            `INSERT INTO oauth_login_challenges
               (id, provider, state_digest, browser_binding_digest, code_verifier_envelope,
                return_path, created_at, expires_at)
             VALUES (?, 'github', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            digestText(state),
            digestText(browserBinding),
            encodeVerifier(codeVerifier),
            returnPath,
            now,
            now + CHALLENGE_TTL_MS,
          );
      }, db);

      return {
        challengeId: id,
        state,
        browserBinding,
        codeVerifier,
        codeChallenge: codeChallengeFromVerifier(codeVerifier),
        authorizeUrlState: state,
      };
    },

    consume(input) {
      if (typeof input.state !== 'string' || input.state.trim() === '') {
        throw err.input('缺少 OAuth state。');
      }
      if (typeof input.browserBinding !== 'string' || input.browserBinding.trim() === '') {
        throw err.input('缺少浏览器绑定标识。');
      }

      const now = nowMs();
      return withTransaction((tx: Tx) => {
        const row = tx.db
          .prepare(
            `SELECT id, state_digest, browser_binding_digest, code_verifier_envelope,
                    return_path, created_at, expires_at, consumed_at
               FROM oauth_login_challenges WHERE state_digest = ?`,
          )
          .get(digestText(input.state)) as ChallengeRow | undefined;

        // 找不到 → 统一拒绝（不区分"state 不对"和"挑战不存在"，避免被用来探测）
        if (!row) throw err.unavailable('登录会话无效或已过期，请重新登录。');
        if (row.browser_binding_digest !== digestText(input.browserBinding)) {
          throw err.unavailable('登录会话与当前浏览器不匹配，请重新登录。');
        }
        // [反恒真自检] 不再拒绝已消费挑战
        if (row.expires_at <= now) {
          throw err.unavailable('登录会话已过期，请重新登录。');
        }

        // 原子消费：条件更新保证并发回调只有一个成功。
        const updated = tx.db
          .prepare('UPDATE oauth_login_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
          .run(now, row.id);
        if (updated.changes === 0) {
          throw err.conflict('该登录请求已被使用，请重新登录。');
        }

        return {
          challengeId: row.id,
          codeVerifier: decodeVerifier(row.code_verifier_envelope),
          returnPath: row.return_path,
        };
      }, db);
    },
  };
}
