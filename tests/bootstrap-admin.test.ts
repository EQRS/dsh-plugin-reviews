/**
 * 首个管理员的**部署引导**（`.env.example` 的 `BOOTSTRAP_ADMIN_GITHUB_ID`）。
 *
 * 为什么单独一个文件：这条规则有两个容易写错的边界，值得单独钉住 ——
 *  1. 用户名会变，只有 GitHub **稳定数字 ID** 能当身份；
 *  2. 它必须是"引导"而不是"永久提权"：**当前已有可用管理员时不生效**，
 *     否则被别的管理员降权的账号下次登录就自动变回管理员，"撤销"永远无效。
 *
 * 反同义反复：把 `bootstrapAdminWithin` 里的 `admins > 0` 判断删掉，第 3 条用例必然变红。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { bootstrapAdminWithin, createIdentityService } from '../src/server/modules/identity/service';
import type { IdentifiedGithubUser } from '../src/server/modules/identity/types';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

function githubUser(providerUserId: string, providerUsername = 'someone'): IdentifiedGithubUser {
  return {
    providerUserId,
    providerUsername,
    profileUrl: `https://github.com/${providerUsername}`,
    avatarUrl: null,
    displayName: providerUsername,
  };
}

function roleOf(db: TestDb['db'], userId: string): string {
  return (db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string }).role;
}

describe('首个管理员引导（BOOTSTRAP_ADMIN_GITHUB_ID）', () => {
  it('库中还没有管理员时，配置里指定的那个 GitHub 稳定 ID 首次登录即成为管理员', async () => {
    const { db } = setup();
    const identity = createIdentityService({ db, env: { ...process.env, BOOTSTRAP_ADMIN_GITHUB_ID: '1234567' } });

    const signed = await identity.signInWithGithub(githubUser('1234567', 'owner'), Date.now());
    expect(roleOf(db, signed.userId)).toBe('admin');

    // 第二次登录不该再动它（幂等），也不该报错
    const again = await identity.signInWithGithub(githubUser('1234567', 'owner-renamed'), Date.now());
    expect(again.created).toBe(false);
    expect(roleOf(db, again.userId)).toBe('admin');
  });

  it('GitHub 用户名改成什么都没用 —— 身份只认稳定 ID', async () => {
    const { db } = setup();
    const identity = createIdentityService({ db, env: { ...process.env, BOOTSTRAP_ADMIN_GITHUB_ID: 'owner' } });

    // 配置里写的是用户名而不是数字 ID：**不提**（用户名可以改，认它就等于给了个可伪造的身份）
    const signed = await identity.signInWithGithub(githubUser('9999999', 'owner'), Date.now());
    expect(roleOf(db, signed.userId)).toBe('user');
  });

  it('库中已有可用管理员时不生效（被降权的账号不会"自己变回来"）', async () => {
    const { db } = setup();
    const admin = insertUser(db, { role: 'admin' });

    const changed = bootstrapAdminWithin(db, {
      userId: insertUser(db),
      providerUserId: '1234567',
      now: Date.now(),
      env: { ...process.env, BOOTSTRAP_ADMIN_GITHUB_ID: '1234567' },
    });
    expect(changed).toBe(false);
    expect(roleOf(db, admin)).toBe('admin');
  });

  it('只有已禁用的管理员时，引导仍然生效（否则没人能审内容）', async () => {
    const { db } = setup();
    insertUser(db, { role: 'admin', accountStatus: 'disabled' });
    const candidate = insertUser(db);

    const changed = bootstrapAdminWithin(db, {
      userId: candidate,
      providerUserId: '1234567',
      now: Date.now(),
      env: { ...process.env, BOOTSTRAP_ADMIN_GITHUB_ID: '1234567' },
    });
    expect(changed).toBe(true);
    expect(roleOf(db, candidate)).toBe('admin');
  });

  it('变量留空 = 完全不开启，谁都不会被提升', async () => {
    const { db } = setup();
    const identity = createIdentityService({ db, env: { ...process.env, BOOTSTRAP_ADMIN_GITHUB_ID: '' } });

    const signed = await identity.signInWithGithub(githubUser('1234567', 'owner'), Date.now());
    expect(roleOf(db, signed.userId)).toBe('user');
  });
});
