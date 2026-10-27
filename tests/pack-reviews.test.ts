/**
 * 整合包测评（迁移 0022）：对象是整合包版本，与插件测评分开。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createPacksService } from '../src/server/modules/packs';
import { createPackReviewsService } from '../src/server/modules/pack-reviews';
import { resolveVisibilityInTx } from '../src/server/modules/content';
import type { CallerContext } from '../src/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

const V: VersionValue = { kind: 'known', value: '1.0.0' };

async function makePack(db: TestDb['db'], userId: string): Promise<{ packId: string; releaseId: string }> {
  const repo = insertRepository(db, 'gh-pack-review-' + Math.random().toString(16).slice(2));
  const plugin = insertPlugin(db, repo, '.');
  const packs = createPacksService({ db });
  return packs.createPackWithFirstRelease(
    caller(db, userId),
    {
      title: '包',
      purpose: '用途',
      bodyMarkdown: '正文',
      dshVersion: V,
      configTemplate: null,
      testStatus: 'untested',
      testTask: null,
      testResult: null,
      items: [{ pluginId: plugin, pluginVersion: V, installTarget: null }],
    },
    db,
  );
}

describe('整合包测评（挂版本）', () => {
  it('对版本创建测评后公开可见，列表与详情可读', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db, { nickname: '测评员' });
    const { releaseId } = await makePack(db, user);
    const service = createPackReviewsService({ db });

    const created = await service.createPackReview(
      caller(db, user),
      {
        releaseId,
        title: '这套组合很好用',
        bodyMarkdown: '正文内容',
        dshVersion: JSON.stringify(V),
        verdict: 'helpful',
        assessmentLevel: 'standard',
      },
      db,
    );

    expect(resolveVisibilityInTx(db, created.reviewId).publiclyVisible).toBe(true);

    const list = await service.listPackReviews(caller(db, user), undefined, db);
    expect(list.map((r) => r.reviewId)).toContain(created.reviewId);
    const detail = await service.getPackReview(caller(db, user), created.reviewId, db);
    expect(detail.title).toBe('这套组合很好用');
    expect(detail.releaseId).toBe(releaseId);
    expect(detail.verdict).toBe('helpful');
  });

  it('撤回的版本不能再写测评', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db);
    const { releaseId } = await makePack(db, user);
    db.prepare(
      'UPDATE content_entities SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1 WHERE id = ?',
    ).run(Date.now(), '测试撤回', releaseId);
    const service = createPackReviewsService({ db });
    try {
      await service.createPackReview(
        caller(db, user),
        { releaseId, title: 'x', bodyMarkdown: 'y', dshVersion: JSON.stringify(V) },
        db,
      );
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.TARGET_UNAVAILABLE);
    }
  });

  it('标题/正文校验', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db);
    const { releaseId } = await makePack(db, user);
    const service = createPackReviewsService({ db });
    const base = { releaseId, bodyMarkdown: '正文', dshVersion: JSON.stringify(V) };
    for (const bad of [
      { ...base, title: '' },
      { ...base, title: '标题', bodyMarkdown: '' },
    ]) {
      try {
        await service.createPackReview(caller(db, user), bad, db);
        throw new Error('应当被拒绝');
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
      }
    }
  });
});
