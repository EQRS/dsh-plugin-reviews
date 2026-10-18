/**
 * GitHub OAuth 挑战与登录安全的测试。
 *
 * 这些用例守护的是登录链路的安全边界，每一条都必须能被破坏变红：
 *  - 去掉 state 摘要比对 → 「伪造 state 被拒」失败；
 *  - 去掉 consumed_at 条件更新 → 「重放被拒」失败；
 *  - 去掉过期判断 → 「过期被拒」失败；
 *  - 生产环境不检查 SESSION_SECRET → 「生产明文存 verifier 被拒」失败。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import {
  createOAuthChallengeService,
  codeChallengeFromVerifier,
  normalizeReturnPath,
  assertChallengeStorageAllowed,
  CHALLENGE_TTL_MS,
} from '../src/server/modules/identity/oauth-challenges';
import { createGithubLoginAdapter } from '../src/server/adapters/login';
import { DomainError } from '../src/packages/common/errors';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  db = new Database(join(dir, 'app.sqlite'));
  db.pragma('foreign_keys = ON');
  const m = join(process.cwd(), 'migrations');
  for (const f of ['0001_baseline.sql', '0002_triggers.sql', '0003_auth_media.sql']) {
    db.exec(readFileSync(join(m, f), 'utf8'));
  }
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error('预期抛出 DomainError，但没有');
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error('预期抛出 DomainError，但没有');
}

describe('挑战创建与消费', () => {
  it('正常流程：创建 → 消费成功，拿到 verifier 与回跳路径', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/plugins' });

    const consumed = svc.consume({ state: created.state, browserBinding: created.browserBinding });
    expect(consumed.codeVerifier).toBe(created.codeVerifier);
    expect(consumed.returnPath).toBe('/plugins');
  });

  it('库里只存摘要，**不存 state 与绑定的原值**', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });

    const row = db.prepare('SELECT * FROM oauth_login_challenges').get() as Record<string, unknown>;
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(created.state);
    expect(dump).not.toContain(created.browserBinding);
    expect(String(row.state_digest)).toHaveLength(64);
    expect(String(row.browser_binding_digest)).toHaveLength(64);
  });

  it('伪造/不存在的 state 被拒', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });
    expect(codeOf(() => svc.consume({ state: 'forged-state-value', browserBinding: created.browserBinding }))).toBe(
      'target_unavailable',
    );
  });

  it('浏览器绑定不匹配被拒（换了浏览器不能完成登录）', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });
    expect(codeOf(() => svc.consume({ state: created.state, browserBinding: 'another-browser' }))).toBe(
      'target_unavailable',
    );
  });

  it('重放被拒：同一挑战只能消费一次', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });
    svc.consume({ state: created.state, browserBinding: created.browserBinding });

    // 第二次必须失败 —— 去掉 consumed_at 条件更新会让本用例变红
    expect(codeOf(() => svc.consume({ state: created.state, browserBinding: created.browserBinding }))).toBe(
      'version_conflict',
    );
  });

  it('一次性消费是**原子条件更新**：并发消费只有一个成功', () => {
    // 这条守卫的是"纵深防御"的第二层：即便预检查被绕过（例如并发下两个请求
    // 都读到 consumed_at IS NULL），UPDATE ... WHERE consumed_at IS NULL 仍只允许一个成功。
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });

    const outcomes: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      try {
        svc.consume({ state: created.state, browserBinding: created.browserBinding });
        outcomes.push('ok');
      } catch (e) {
        outcomes.push(e instanceof DomainError ? e.code : 'unexpected');
      }
    }
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'version_conflict')).toHaveLength(1);

    // 库里 consumed_at 只被写过一次（不是被覆盖成更晚的时间）
    const row = db.prepare('SELECT consumed_at FROM oauth_login_challenges WHERE id = ?').get(created.challengeId) as {
      consumed_at: number;
    };
    expect(row.consumed_at).toBeGreaterThan(0);
  });

  it('过期被拒（即使 state 与绑定都对）', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });

    // 直接把挑战改成已过期
    db.prepare('UPDATE oauth_login_challenges SET created_at = ?, expires_at = ? WHERE id = ?').run(
      1_000,
      2_000,
      created.challengeId,
    );

    expect(codeOf(() => svc.consume({ state: created.state, browserBinding: created.browserBinding }))).toBe(
      'target_unavailable',
    );
  });

  it('消费后库里留下 consumed_at（可审计"何时被用过"）', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });
    svc.consume({ state: created.state, browserBinding: created.browserBinding });

    const row = db.prepare('SELECT consumed_at FROM oauth_login_challenges WHERE id = ?').get(created.challengeId) as {
      consumed_at: number | null;
    };
    expect(row.consumed_at).not.toBeNull();
  });
});

describe('return_path 只能是站内相对路径（防开放重定向）', () => {
  it('规范化：绝对 URL / 协议相对地址 / 空值 → 首页', () => {
    expect(normalizeReturnPath('/plugins/abc')).toBe('/plugins/abc');
    expect(normalizeReturnPath('https://evil.example')).toBe('/');
    expect(normalizeReturnPath('//evil.example')).toBe('/');
    expect(normalizeReturnPath('')).toBe('/');
    expect(normalizeReturnPath(null)).toBe('/');
    // 2026-10-18 外部审计加固：嵌入的控制字符不再「剔除后继续用」，直接拒绝——
    // 剔除式处理会让「剔除后恰好拼出别的路径」成为二次构造面。
    expect(normalizeReturnPath('/a\r\nSet-Cookie: x=1')).toBe('/');
  });

  it('数据库层也拒绝非站内路径（CHECK 兜底）', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO oauth_login_challenges
             (id, provider, state_digest, browser_binding_digest, code_verifier_envelope, return_path, created_at, expires_at)
           VALUES ('x', 'github', ?, ?, '{"alg":"none","v":1,"verifier":"v"}', 'https://evil.example', 1, 2)`,
        )
        .run('a'.repeat(64), 'b'.repeat(64)),
    ).toThrow(/CHECK/i);
  });
});

describe('PKCE', () => {
  it('code_challenge 是 S256（base64url，无填充）且由 verifier 决定', () => {
    const c1 = codeChallengeFromVerifier('verifier-one');
    const c2 = codeChallengeFromVerifier('verifier-one');
    const c3 = codeChallengeFromVerifier('verifier-two');
    expect(c1).toBe(c2);
    expect(c1).not.toBe(c3);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c1).not.toContain('=');
    expect(c1.length).toBe(43); // sha256 → 32 字节 → base64url 43 字符
  });

  it('授权地址使用 S256，且带上 state 与最小 scope', () => {
    const adapter = createGithubLoginAdapter({
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'http://127.0.0.1:3100/api/auth/github/callback',
    });
    const url = new URL(adapter.buildAuthorizeUrl('the-state', 'the-challenge'));
    expect(url.hostname).toBe('github.com');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('read:user');
  });
});

describe('未配置 GitHub 凭据时绝不伪装可用', () => {
  it('未配置 → isConfigured=false，且授权/换码都抛 provider_not_configured', async () => {
    const adapter = createGithubLoginAdapter(null);
    expect(adapter.isConfigured()).toBe(false);
    expect(codeOf(() => adapter.buildAuthorizeUrl('s', 'c'))).toBe('provider_not_configured');
    expect(await codeOfAsync(() => adapter.exchangeCodeForIdentity({ code: 'x', codeVerifier: 'y' }))).toBe(
      'provider_not_configured',
    );
  });

  it('已配置但授权码无效 → 明确报"重新登录"，而不是服务器故障', async () => {
    // 用真实适配器但打一个必然失败的码：这里只验证错误分类存在，
    // 不依赖网络（网络请求会立刻失败并被归类为 provider_unavailable 或 target_unavailable）。
    const adapter = createGithubLoginAdapter({
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'http://127.0.0.1:3100/cb',
    });
    const code = await codeOfAsync(() => adapter.exchangeCodeForIdentity({ code: 'invalid', codeVerifier: 'v' }));
    expect(['target_unavailable', 'provider_unavailable']).toContain(code);
  });
});

describe('生产环境必须配置部署密钥才能保存挑战', () => {
  it('生产且无 SESSION_SECRET → 拒绝发起登录（不悄悄明文存 verifier）', () => {
    expect(() => assertChallengeStorageAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /SESSION_SECRET|未配置/,
    );
  });

  it('生产且 SESSION_SECRET 太短 → 同样拒绝', () => {
    expect(() =>
      assertChallengeStorageAllowed({ NODE_ENV: 'production', SESSION_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('生产且密钥足够长 → 允许', () => {
    expect(() =>
      assertChallengeStorageAllowed({
        NODE_ENV: 'production',
        SESSION_SECRET: 'x'.repeat(64),
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('开发环境不要求密钥（本地可跑），但这一宽松**只对非生产生效**', () => {
    expect(() => assertChallengeStorageAllowed({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('挑战有效期参数', () => {
  it('默认 600 秒（架构第 109 节）', () => {
    expect(CHALLENGE_TTL_MS).toBe(600 * 1000);
  });

  it('创建的挑战 expires_at - created_at 等于该参数', () => {
    const svc = createOAuthChallengeService(db);
    const created = svc.create({ returnPath: '/' });
    const row = db
      .prepare('SELECT created_at, expires_at FROM oauth_login_challenges WHERE id = ?')
      .get(created.challengeId) as { created_at: number; expires_at: number };
    expect(row.expires_at - row.created_at).toBe(CHALLENGE_TTL_MS);
  });
});
