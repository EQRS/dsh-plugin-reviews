/**
 * identity 模块测试（工作包 GI）。
 *
 * 纪律：每个用例都必须**能在实现被破坏时变红**。对照关系在用例名与注释里写明，
 * 例如"重复回调复用用户"这条，若把 signInWithGithub 改成无条件 INSERT，必然失败。
 * 全部使用真实临时文件数据库 + 真实迁移（createTestDb），不使用 :memory:。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createIdentityService } from '../src/server/modules/identity/service';
import { createGithubLoginAdapter, createTestLoginAdapter } from '../src/server/adapters/login';
import { digestText } from '../src/server/platform/digest';
import { DAY, HOUR } from '../src/server/platform/time';
import { isDomainError, ErrorCodes } from '../src/packages/common/errors';
import type { IdentifiedGithubUser, IdentityService } from '../src/server/modules/identity/types';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): { testDb: TestDb; service: IdentityService } {
  const testDb = createTestDb();
  ctx = testDb;
  return { testDb, service: createIdentityService({ db: testDb.db }) };
}

const GITHUB_USER: IdentifiedGithubUser = {
  providerUserId: '1000001',
  providerUsername: 'octocat',
  profileUrl: 'https://github.com/octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1000001',
  displayName: 'Octo Cat',
};

/** 基线时间：固定值，避免测试依赖真实时钟。 */
const T0 = 1_760_000_000_000;

function countUsers(db: TestDb['db']): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

function countIdentities(db: TestDb['db']): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM external_identities').get() as { c: number }).c;
}

describe('signInWithGithub：首次建号与重复回调复用', () => {
  it('首次登录在同一事务内建立 users + external_identities', () => {
    const { testDb, service } = setup();
    return service.signInWithGithub(GITHUB_USER, T0).then((result) => {
      expect(result.created).toBe(true);
      expect(countUsers(testDb.db)).toBe(1);
      expect(countIdentities(testDb.db)).toBe(1);

      const identity = testDb.db
        .prepare('SELECT provider, provider_user_id, provider_username, user_id FROM external_identities')
        .get() as { provider: string; provider_user_id: string; provider_username: string; user_id: string };
      expect(identity.provider).toBe('github');
      expect(identity.provider_user_id).toBe('1000001');
      expect(identity.provider_username).toBe('octocat');
      expect(identity.user_id).toBe(result.userId);

      // 昵称取自 displayName，且必须满足非空白约束。
      const user = testDb.db.prepare('SELECT nickname, role, account_status FROM users').get() as {
        nickname: string;
        role: string;
        account_status: string;
      };
      expect(user.nickname).toBe('Octo Cat');
      expect(user.nickname.trim().length).toBeGreaterThan(0);
      // 新用户默认角色与状态。
      expect(user.role).toBe('user');
      expect(user.account_status).toBe('active');
    });
  });

  it('【对照】同一 GitHub 稳定 ID 重复回调必须复用既有用户，不重复创建', async () => {
    const { testDb, service } = setup();
    const first = await service.signInWithGithub(GITHUB_USER, T0);
    const second = await service.signInWithGithub(GITHUB_USER, T0 + HOUR);
    const third = await service.signInWithGithub(GITHUB_USER, T0 + 2 * HOUR);

    // 若把实现的"先查身份再复用"改成无条件 INSERT，下面三条必然失败。
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(third.userId).toBe(first.userId);

    expect(countUsers(testDb.db)).toBe(1);
    expect(countIdentities(testDb.db)).toBe(1);
  });

  it('重复回调会同步资料（用户名/头像变化时更新身份行，但不换用户）', async () => {
    const { testDb, service } = setup();
    const first = await service.signInWithGithub(GITHUB_USER, T0);
    const renamed = await service.signInWithGithub(
      { ...GITHUB_USER, providerUsername: 'octocat-renamed', avatarUrl: 'https://example.com/new.png' },
      T0 + HOUR,
    );

    expect(renamed.userId).toBe(first.userId);
    const identity = testDb.db
      .prepare('SELECT provider_username, avatar_url, synced_at FROM external_identities WHERE user_id = ?')
      .get(first.userId) as { provider_username: string; avatar_url: string; synced_at: number };
    expect(identity.provider_username).toBe('octocat-renamed');
    expect(identity.avatar_url).toBe('https://example.com/new.png');
    expect(identity.synced_at).toBe(T0 + HOUR);
    expect(countUsers(testDb.db)).toBe(1);
  });

  it('不同 GitHub 稳定 ID 建立不同用户（幂等不能退化成"只允许一个用户"）', async () => {
    const { testDb, service } = setup();
    const a = await service.signInWithGithub(GITHUB_USER, T0);
    const b = await service.signInWithGithub(
      { ...GITHUB_USER, providerUserId: '2000002', providerUsername: 'other' },
      T0,
    );
    expect(a.userId).not.toBe(b.userId);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(countUsers(testDb.db)).toBe(2);
  });

  it('缺少 providerUserId 或 providerUsername 时明确报 input_invalid', async () => {
    const { service } = setup();
    await expect(service.signInWithGithub({ ...GITHUB_USER, providerUserId: '   ' }, T0)).rejects.toMatchObject({
      code: ErrorCodes.INPUT_INVALID,
    });
    await expect(service.signInWithGithub({ ...GITHUB_USER, providerUsername: '' }, T0)).rejects.toMatchObject({
      code: ErrorCodes.INPUT_INVALID,
    });
    expect(countUsers(ctx!.db)).toBe(0);
  });

  it('displayName 为纯空白时回退到 providerUsername，不得把空白昵称写进库', async () => {
    const { testDb, service } = setup();
    // providerUsername 是必填契约，因此昵称来源唯一的合法回退是它。
    // 若 deriveNickname 直接取 displayName 而不判空白，这里会撞 users.nickname 的
    // CHECK(trim(nickname) <> '') 并抛 SQLite 约束错误 —— 本条即变红。
    await service.signInWithGithub({ ...GITHUB_USER, displayName: '   ' }, T0);
    const user = testDb.db.prepare('SELECT nickname FROM users').get() as { nickname: string };
    expect(user.nickname).toBe('octocat');
    expect(user.nickname.trim().length).toBeGreaterThan(0);
  });

  it('displayName 与 providerUsername 都为空白时按契约拒绝（不落一条空昵称用户）', async () => {
    const { testDb, service } = setup();
    await expect(
      service.signInWithGithub({ ...GITHUB_USER, displayName: '   ', providerUsername: '  ' }, T0),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });
    expect(countUsers(testDb.db)).toBe(0);
    expect(countIdentities(testDb.db)).toBe(0);
  });

  it('已禁用账户重新登录被拒绝，且不新建第二个用户', async () => {
    const { testDb, service } = setup();
    const first = await service.signInWithGithub(GITHUB_USER, T0);
    testDb.db.prepare("UPDATE users SET account_status = 'disabled' WHERE id = ?").run(first.userId);

    await expect(service.signInWithGithub(GITHUB_USER, T0 + HOUR)).rejects.toMatchObject({
      code: ErrorCodes.ACCOUNT_DISABLED,
    });
    expect(countUsers(testDb.db)).toBe(1);
  });
});

describe('createSession：明文只进 Cookie，库里只存摘要', () => {
  it('【对照】库里存的不是明文 token：token_digest 不等于明文且长度为 64', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    const row = testDb.db
      .prepare('SELECT id, token_digest, created_at, expires_at, absolute_expires_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as {
      id: string;
      token_digest: string;
      created_at: number;
      expires_at: number;
      absolute_expires_at: number;
    };

    // 若把实现改成 `INSERT ... token_digest = token`，这三条必然失败：
    // 明文是 base64url 的 43 字符，长度不可能等于 64，且不等于其 SHA-256。
    expect(row.token_digest).not.toBe(session.token);
    expect(row.token_digest.length).toBe(64);
    expect(row.token_digest).toBe(digestText(session.token));
    // 明文本身确实是不可预测的长凭证（不是可枚举的小整数）。
    expect(session.token.length).toBeGreaterThanOrEqual(43);
  });

  it('数据库中不存在任何保存明文 token 的列（整行文本里搜不到明文）', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    // 逐列扫描整行：任何一列等于明文即为泄露。
    const row = testDb.db.prepare('SELECT * FROM user_sessions WHERE id = ?').get(session.sessionId) as Record<
      string,
      unknown
    >;
    for (const [column, value] of Object.entries(row)) {
      expect(value, `列 ${column} 不应保存明文凭证`).not.toBe(session.token);
    }
  });

  it('有效期按架构第 105 节：7 天 / 30 天，且 created ≤ expires ≤ absolute', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    expect(session.expiresAt).toBe(T0 + 7 * DAY);
    expect(session.absoluteExpiresAt).toBe(T0 + 30 * DAY);

    const row = testDb.db
      .prepare('SELECT created_at, expires_at, absolute_expires_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { created_at: number; expires_at: number; absolute_expires_at: number };
    expect(row.created_at).toBe(T0);
    expect(row.created_at).toBeLessThanOrEqual(row.expires_at);
    expect(row.expires_at).toBeLessThanOrEqual(row.absolute_expires_at);
  });

  it('同一用户的多次登录产生彼此独立的会话与不同 token_digest', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const a = await service.createSession(userId, T0);
    const b = await service.createSession(userId, T0 + 1000);

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.token).not.toBe(b.token);
    const digests = testDb.db.prepare('SELECT token_digest FROM user_sessions').all() as { token_digest: string }[];
    expect(digests).toHaveLength(2);
    expect(new Set(digests.map((d) => d.token_digest)).size).toBe(2);
  });

  it('对已禁用账户建立会话被拒绝，且不留下会话行', async () => {
    const { testDb, service } = setup();
    const userId = insertUser(testDb.db, { accountStatus: 'disabled' });
    await expect(service.createSession(userId, T0)).rejects.toMatchObject({ code: ErrorCodes.ACCOUNT_DISABLED });
    const count = testDb.db.prepare('SELECT COUNT(*) AS c FROM user_sessions').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('对不存在的用户建立会话被拒绝（不产生悬挂外键）', async () => {
    const { service } = setup();
    await expect(service.createSession('00000000-0000-7000-8000-000000000000', T0)).rejects.toMatchObject({
      code: ErrorCodes.TARGET_UNAVAILABLE,
    });
  });
});

describe('resolveSession：无效/过期/撤销/禁用一律返回 null', () => {
  it('有效凭证解析出正确上下文，且角色与状态来自数据库', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    testDb.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
    const session = await service.createSession(userId, T0);

    const resolved = await service.resolveSession(session.token, T0 + HOUR);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(userId);
    expect(resolved!.role).toBe('admin');
    expect(resolved!.accountStatus).toBe('active');
    expect(resolved!.sessionId).toBe(session.sessionId);
  });

  it('【对照】伪造/未知凭证返回 null', async () => {
    const { service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    await service.createSession(userId, T0);
    expect(await service.resolveSession('not-a-real-token', T0)).toBeNull();
    expect(await service.resolveSession('', T0)).toBeNull();
  });

  it('【对照】过期会话返回 null（普通有效期到期）', async () => {
    const { service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    // 到期前一刻有效，到期时刻起失效（notExpired 语义：严格大于 now）。
    expect(await service.resolveSession(session.token, session.expiresAt - 1)).not.toBeNull();
    expect(await service.resolveSession(session.token, session.expiresAt)).toBeNull();
    expect(await service.resolveSession(session.token, session.expiresAt + 1)).toBeNull();
  });

  it('【对照】撤销后的会话返回 null', async () => {
    const { service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);
    expect(await service.resolveSession(session.token, T0 + HOUR)).not.toBeNull();

    await service.revokeSession(session.sessionId, T0 + HOUR);
    expect(await service.resolveSession(session.token, T0 + HOUR + 1)).toBeNull();
  });

  it('【对照】账户被禁用后既有会话立刻失效（状态每次从库里读，不缓存）', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);
    expect(await service.resolveSession(session.token, T0 + HOUR)).not.toBeNull();

    testDb.db.prepare("UPDATE users SET account_status = 'disabled' WHERE id = ?").run(userId);
    expect(await service.resolveSession(session.token, T0 + HOUR + 1)).toBeNull();
  });

  it('【对照】撤销管理员后，其普通会话立即失去管理角色（不读旧快照）', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    testDb.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
    const session = await service.createSession(userId, T0);
    expect((await service.resolveSession(session.token, T0 + HOUR))!.role).toBe('admin');

    testDb.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(userId);
    const after = await service.resolveSession(session.token, T0 + HOUR + 1);
    expect(after).not.toBeNull();
    expect(after!.role).toBe('user');
  });

  it('超过 absolute_expires_at 的会话即失效（absolute 是硬上限）', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    // 表上 CHECK(created ≤ expires ≤ absolute) 使 "expires 晚于 absolute" **不可表示**，
    // 即 absolute 生效时必然等于 expires。因此本用例验证的是：
    //  ① absolute 到点前 1ms 仍有效（严格大于 now）；
    //  ② absolute 到点即失效；
    //  ③ 人为把两者一起夹紧后，判定确实跟着 absolute 走（不是只在建会话时才用 30 天）。
    const absolute = T0 + HOUR;
    testDb.db
      .prepare('UPDATE user_sessions SET expires_at = ?, absolute_expires_at = ? WHERE id = ?')
      .run(absolute, absolute, session.sessionId);

    expect(await service.resolveSession(session.token, absolute - 1)).not.toBeNull();
    expect(await service.resolveSession(session.token, absolute)).toBeNull();
    expect(await service.resolveSession(session.token, absolute + 1)).toBeNull();

    // 另一个方向：把 absolute 拉长（模拟"续期后 expires 被夹到 absolute"的最终状态），
    // 确认 now 落在 (expires, absolute] 之间时也失效 —— 即会话不会因绝对上限较远而免于普通到期。
    const expires2 = T0 + 2 * DAY;
    const absolute2 = T0 + 30 * DAY;
    testDb.db
      .prepare('UPDATE user_sessions SET expires_at = ?, absolute_expires_at = ? WHERE id = ?')
      .run(expires2, absolute2, session.sessionId);
    expect(await service.resolveSession(session.token, expires2 - 1)).not.toBeNull();
    expect(await service.resolveSession(session.token, expires2)).toBeNull();
    expect(await service.resolveSession(session.token, T0 + 10 * DAY)).toBeNull();
  });
});

describe('touchSession：续期受 24 小时间隔与 absolute 上限约束', () => {
  it('【对照】距上次续期不足 24 小时不动 expires_at', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    await service.touchSession(session.sessionId, T0 + HOUR); // 仅过 1 小时
    const row = testDb.db
      .prepare('SELECT expires_at, last_renewed_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { expires_at: number; last_renewed_at: number };
    // 若实现去掉 24 小时判断（每次都续期），expires_at 会变成 T0+HOUR+7天，本条失败。
    expect(row.expires_at).toBe(T0 + 7 * DAY);
    expect(row.last_renewed_at).toBe(T0);
  });

  it('距上次续期满 24 小时后续期：expires_at = 访问时间 + 7 天', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    const touchAt = T0 + 24 * HOUR;
    await service.touchSession(session.sessionId, touchAt);
    const row = testDb.db
      .prepare('SELECT expires_at, last_renewed_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { expires_at: number; last_renewed_at: number };
    expect(row.expires_at).toBe(touchAt + 7 * DAY);
    expect(row.last_renewed_at).toBe(touchAt);
  });

  it('【对照】续期不得超过 absolute_expires_at', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    // 走真实续期路径：每 24 小时访问一次，会话才能活到第 29 天。
    // （未续期的会话 7 天后即过期，day 29 再访问属于"已过期"，不在本用例范围。）
    let cursor = T0;
    while (cursor + DAY < T0 + 29 * DAY) {
      cursor += DAY;
      await service.touchSession(session.sessionId, cursor);
    }

    // 第 29 天访问：now + 7 天 = 第 36 天，越过 30 天上限，必须被夹到 absolute。
    const touchAt = T0 + 29 * DAY;
    await service.touchSession(session.sessionId, touchAt);
    const row = testDb.db
      .prepare('SELECT expires_at, absolute_expires_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { expires_at: number; absolute_expires_at: number };
    // 若实现写成 `expires_at = now + 7天` 而不取 min，这里会是 T0+36天，本条失败。
    expect(row.expires_at).toBe(T0 + 30 * DAY);
    expect(row.expires_at).toBe(T0 + 29 * DAY + DAY);
    expect(row.expires_at).toBeLessThanOrEqual(row.absolute_expires_at);
    // 夹到上限后，绝对上限本身不得被延长。
    expect(row.absolute_expires_at).toBe(T0 + 30 * DAY);
  });

  it('【对照】已撤销会话不能被续期"复活"', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);
    await service.revokeSession(session.sessionId, T0 + HOUR);

    await service.touchSession(session.sessionId, T0 + 25 * HOUR);
    const row = testDb.db
      .prepare('SELECT expires_at, last_renewed_at, revoked_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { expires_at: number; last_renewed_at: number; revoked_at: number };
    expect(row.expires_at).toBe(T0 + 7 * DAY);
    expect(row.last_renewed_at).toBe(T0);
    expect(row.revoked_at).toBe(T0 + HOUR);
    expect(await service.resolveSession(session.token, T0 + 25 * HOUR)).toBeNull();
  });

  it('已过期会话不能被续期', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    await service.touchSession(session.sessionId, session.expiresAt + HOUR);
    const row = testDb.db
      .prepare('SELECT expires_at, last_renewed_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { expires_at: number; last_renewed_at: number };
    expect(row.expires_at).toBe(T0 + 7 * DAY);
    expect(row.last_renewed_at).toBe(T0);
  });

  it('不存在的会话 ID 静默返回（续期是尽力而为，不抛错）', async () => {
    const { service } = setup();
    await expect(service.touchSession('00000000-0000-7000-8000-000000000000', T0)).resolves.toBeUndefined();
  });

  it('活动时间按 activity_write_interval_seconds=300 控制写入频率', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    const readSeen = () =>
      (testDb.db.prepare('SELECT last_seen_at FROM user_sessions WHERE id = ?').get(session.sessionId) as {
        last_seen_at: number;
      }).last_seen_at;

    // 距上次活动不足 300 秒：不写（避免每个请求都产生一次写）。
    await service.touchSession(session.sessionId, T0 + 100 * 1000);
    expect(readSeen()).toBe(T0);

    // 满 300 秒：写一次。
    await service.touchSession(session.sessionId, T0 + 300 * 1000);
    expect(readSeen()).toBe(T0 + 300 * 1000);

    // 再涨 100 秒（不足 300）：不再写，值保持不变。
    await service.touchSession(session.sessionId, T0 + 400 * 1000);
    expect(readSeen()).toBe(T0 + 300 * 1000);

    // 期间因为不足 24h，续期字段始终不动。
    const row = testDb.db
      .prepare('SELECT expires_at, last_renewed_at FROM user_sessions WHERE id = ?')
      .get(session.sessionId) as { expires_at: number; last_renewed_at: number };
    expect(row.expires_at).toBe(T0 + 7 * DAY);
    expect(row.last_renewed_at).toBe(T0);
  });
});

describe('revokeSession 与 updateProfile', () => {
  it('撤销是幂等的：重复撤销不覆盖首次撤销时间', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);
    const session = await service.createSession(userId, T0);

    await service.revokeSession(session.sessionId, T0 + HOUR);
    await service.revokeSession(session.sessionId, T0 + 2 * HOUR);
    const row = testDb.db.prepare('SELECT revoked_at FROM user_sessions WHERE id = ?').get(session.sessionId) as {
      revoked_at: number;
    };
    expect(row.revoked_at).toBe(T0 + HOUR);
  });

  it('updateProfile 保存昵称与头像；拒绝纯空白昵称', async () => {
    const { testDb, service } = setup();
    const { userId } = await service.signInWithGithub(GITHUB_USER, T0);

    await service.updateProfile(
      { userId, role: 'user', accountStatus: 'active' },
      { nickname: '  新名字  ', avatarUrl: 'https://example.com/a.png' },
    );
    const row = testDb.db.prepare('SELECT nickname, avatar_url FROM users WHERE id = ?').get(userId) as {
      nickname: string;
      avatar_url: string;
    };
    expect(row.nickname).toBe('新名字');
    expect(row.avatar_url).toBe('https://example.com/a.png');

    await expect(
      service.updateProfile({ userId, role: 'user', accountStatus: 'active' }, { nickname: '   ' }),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });
  });

  it('updateProfile 拒绝未登录与被禁用账户', async () => {
    const { testDb, service } = setup();
    const userId = insertUser(testDb.db, { accountStatus: 'disabled' });

    await expect(
      service.updateProfile({ userId: null, role: null, accountStatus: null }, { nickname: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCodes.UNAUTHENTICATED });

    await expect(
      service.updateProfile({ userId, role: 'user', accountStatus: 'disabled' }, { nickname: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCOUNT_DISABLED });
  });
});

describe('登录适配器：未配置绝不伪装可用', () => {
  it('【对照】未配置 GITHUB_CLIENT_ID/SECRET 时 isConfigured=false 且调用抛 provider_not_configured', async () => {
    const adapter = createGithubLoginAdapter(null);
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.kind).toBe('github');

    // 若实现"未配置时返回假身份/样例用户"，下面两条必然失败。
    await expect(adapter.exchangeCodeForIdentity({ code: 'abc', codeVerifier: 'v' })).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NOT_CONFIGURED,
    });
    expect(() => adapter.buildAuthorizeUrl('state', 'challenge')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROVIDER_NOT_CONFIGURED }),
    );
  });

  it('已配置时 isConfigured=true，但未接通的令牌交换报 provider_unavailable（不返回伪造身份）', async () => {
    const adapter = createGithubLoginAdapter({
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://example.com/callback',
    });
    expect(adapter.isConfigured()).toBe(true);

    const url = adapter.buildAuthorizeUrl('state-1', 'challenge-1');
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=state-1');
    expect(url).toContain('code_challenge_method=S256');
    // 凭据不得出现在授权地址里。
    expect(url).not.toContain('secret');

    await expect(adapter.exchangeCodeForIdentity({ code: 'abc', codeVerifier: 'v' })).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_UNAVAILABLE,
    });
  });

  it('授权地址在缺少 state 或 code_challenge 时被拒绝', () => {
    const adapter = createGithubLoginAdapter({
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://example.com/callback',
    });
    expect(() => adapter.buildAuthorizeUrl('', 'challenge')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.INPUT_INVALID }),
    );
    expect(() => adapter.buildAuthorizeUrl('state', '')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.INPUT_INVALID }),
    );
  });

  it('测试适配器仅在 NODE_ENV=test 下可用，且直接返回桩身份', async () => {
    const identity: IdentifiedGithubUser = {
      providerUserId: 'test-1',
      providerUsername: 'tester',
      profileUrl: 'https://github.com/tester',
      avatarUrl: null,
      displayName: 'Tester',
    };
    const adapter = createTestLoginAdapter(identity, { NODE_ENV: 'test' });
    expect(adapter.kind).toBe('test');
    expect(adapter.isConfigured()).toBe(true);
    const got = await adapter.exchangeCodeForIdentity({ code: 'c', codeVerifier: 'v' });
    expect(got).toEqual(identity);
    // 返回副本，调用方修改不应污染桩。
    got.providerUsername = 'mutated';
    expect((await adapter.exchangeCodeForIdentity({ code: 'c', codeVerifier: 'v' })).providerUsername).toBe('tester');
  });

  it('【对照】测试适配器在非 test 环境构造即失败（防止被接到真实登录入口）', () => {
    const identity: IdentifiedGithubUser = {
      providerUserId: 'test-1',
      providerUsername: 'tester',
      profileUrl: 'https://github.com/tester',
      avatarUrl: null,
      displayName: null,
    };
    expect(() => createTestLoginAdapter(identity, { NODE_ENV: 'production' })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.INTERNAL }),
    );
  });
});

describe('端到端：适配器 → signIn → createSession → resolveSession', () => {
  it('测试登录适配器产出的身份可以完整走通登录闭环', async () => {
    const { service } = setup();
    const adapter = createTestLoginAdapter(
      {
        providerUserId: '4242',
        providerUsername: 'e2e-user',
        profileUrl: 'https://github.com/e2e-user',
        avatarUrl: null,
        displayName: null,
      },
      { NODE_ENV: 'test' },
    );

    const identity = await adapter.exchangeCodeForIdentity({ code: 'code', codeVerifier: 'verifier' });
    const signIn = await service.signInWithGithub(identity, T0);
    expect(signIn.created).toBe(true);

    const session = await service.createSession(signIn.userId, T0);
    const resolved = await service.resolveSession(session.token, T0 + HOUR);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(signIn.userId);
    // displayName 为空时昵称回退到 providerUsername。
    expect(resolved!.accountStatus).toBe('active');

    await service.revokeSession(session.sessionId, T0 + 2 * HOUR);
    expect(await service.resolveSession(session.token, T0 + 3 * HOUR)).toBeNull();
  });

  it('错误对象是 DomainError 而不是裸 Error（接口层才能映射出正确状态码）', async () => {
    const { service } = setup();
    try {
      await service.createSession('00000000-0000-7000-8000-000000000000', T0);
      throw new Error('预期抛出错误，但没有');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
    }
  });
});
