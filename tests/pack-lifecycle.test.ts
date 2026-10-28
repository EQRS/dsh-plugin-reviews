/**
 * 整合包生命周期：草稿（未上传）→ 待审核 → 已发布 / 已拒绝；编辑、删除、撤回。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createPacksService } from '../src/server/modules/packs';
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

function input(pluginId: string, title = '组合包') {
  return {
    title,
    purpose: '用途说明',
    bodyMarkdown: '组合使用说明',
    dshVersion: V,
    configTemplate: null,
    testStatus: 'untested' as const,
    testTask: null,
    testResult: null,
    items: [{ pluginId, pluginVersion: V, installTarget: null }],
  };
}

async function makeDraft(
  db: TestDb['db'],
  author: string,
): Promise<{ packId: string; releaseId: string; pluginId: string }> {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo, '.');
  const created = await createPacksService({ db }).createPackDraft(caller(db, author), input(plugin), db);
  return { ...created, pluginId: plugin };
}

describe('整合包生命周期', () => {
  it('草稿不公开；上传后待审核；管理员通过后公开', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const draft = await makeDraft(db, author);
    const service = createPacksService({ db });

    // 草稿：公开列表没有，详情没有公开版本
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(0);
    expect((await service.getPack(caller(db, author), draft.packId, {}, db)).selected).toBeNull();

    const submitted = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    expect(submitted.reviewStatus).toBe('pending');

    // 待审核仍不公开
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(0);

    const approved = await service.approveRelease(caller(db, admin), draft.releaseId, db);
    expect(approved.releaseNumber).toBe(1);
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(1);
    expect((await service.getPack(caller(db, author), draft.packId, {}, db)).selected?.releaseNumber).toBe(1);
  });

  it('拒绝后可编辑并重新提交；已发布不可编辑', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const draft = await makeDraft(db, author);
    const service = createPacksService({ db });

    await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    await service.rejectRelease(caller(db, admin), draft.releaseId, '缺少说明', db);

    // 被拒后可编辑
    await service.updateDraftRelease(caller(db, author), draft.releaseId, input(draft.pluginId, '新标题'), db);
    const updated = db.prepare('SELECT title, review_status FROM plugin_pack_releases WHERE id = ?').get(draft.releaseId) as {
      title: string;
      review_status: string;
    };
    expect(updated.title).toBe('新标题');
    expect(updated.review_status).toBe('rejected');

    // 重新提交 → 待审 → 通过
    await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    await service.approveRelease(caller(db, admin), draft.releaseId, db);

    // 已发布不可编辑
    try {
      await service.updateDraftRelease(caller(db, author), draft.releaseId, input(draft.pluginId, '再改'), db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }
  });

  it('删除草稿；已发布只能撤回', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const draft = await makeDraft(db, author);
    const service = createPacksService({ db });

    await service.deleteDraftRelease(caller(db, author), draft.releaseId, db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM plugin_pack_releases WHERE id = ?').get(draft.releaseId)).toEqual({ c: 0 });

    const second = await makeDraft(db, author);
    await service.submitReleaseForReview(caller(db, author), second.releaseId, db);
    await service.approveRelease(caller(db, admin), second.releaseId, db);

    try {
      await service.deleteDraftRelease(caller(db, author), second.releaseId, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }

    await service.withdrawRelease(caller(db, author), second.packId, second.releaseId, null, db);
    expect((await service.listPublicPacks({}, db)).items).toHaveLength(0);
  });

  it('非作者不能上传/编辑/删除；非管理员不能审核', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const other = insertUser(db);
    const draft = await makeDraft(db, author);
    const service = createPacksService({ db });

    for (const promise of [
      service.submitReleaseForReview(caller(db, other), draft.releaseId, db),
      service.updateDraftRelease(caller(db, other), draft.releaseId, input(draft.pluginId), db),
      service.deleteDraftRelease(caller(db, other), draft.releaseId, db),
    ]) {
      try {
        await promise;
        throw new Error('应当被拒绝');
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
      }
    }

    await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    try {
      await service.approveRelease(caller(db, author), draft.releaseId, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }
  });
});
