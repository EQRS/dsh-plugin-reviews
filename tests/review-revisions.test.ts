/**
 * 修订历史接口（`GET /api/reviews/{reviewId}/revisions`）的语义与安全回归测试。
 *
 * 这个接口把"哪些字段能下发"从一个界面的选择变成了一个**权限边界**，所以必须有用例钉住：
 *  1. 公开访客只拿到元信息（提交时间 + 公开状态 + 当前公开修订标识），
 *     **响应里绝不能出现任何修订的标题或正文**（`review_revisions` 的正文是私有材料）；
 *  2. 作者本人与管理员额外拿到标题、Markdown 原文与已净化 HTML；
 *  3. 评测不存在 → 404；评测存在但当前不公开（撤回/隐藏/未发布）时，
 *     非作者非管理员同样 404 —— 不用 403 泄露"这里有私有内容"；
 *  4. 曾经公开过、现已被取代的修订要如实标注（`superseded`），
 *     当前公开修订标 `current`，其余标 `unpublished`。
 *
 * 反同义反复：把 route 里 `if (canReadBodies)` 那一段删掉（无条件下发 title/body），
 * 第 1、4 条用例必然变红；把可见性判断删掉，第 5 条必然变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话 Cookie 的可变桩：读取时按当前值返回（避免每个用例都重建模块）。 */
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (auth.token === null ? undefined : { name, value: auth.token }),
  }),
}));

import { GET } from '../src/app/api/reviews/[reviewId]/revisions/route';
import { closeDb, type SqliteDatabase } from '../src/server/platform/db';
import { createTestDb, insertPlugin, insertRepository, insertReview, insertReviewRevision, insertUser, type TestDb } from './support/db';
import { newId } from '../src/server/platform/id';
import { createIdentityService } from '../src/server/modules/identity';

let h: TestDb;
let db: SqliteDatabase;

beforeEach(() => {
  h = createTestDb();
  db = h.db;
  // 接口内部走 getDb()：把它指向本次用例的临时库，并让出旧单例。
  process.env.DSH_REVIEW_DB_PATH = h.file;
  closeDb();
  auth.token = null;
});

afterEach(() => {
  closeDb();
  h.cleanup();
  delete process.env.DSH_REVIEW_DB_PATH;
});

interface Seed {
  reviewId: string;
  authorId: string;
  adminId: string;
  strangerId: string;
  rev1: string;
  rev2: string;
  rev3: string;
}

interface RevisionDto {
  revisionId: string;
  revisionNumber: number;
  submittedAt: string;
  status: string;
  isCurrentPublished: boolean;
  wasPublished: boolean;
  isSuperseded: boolean;
  isWithdrawn: boolean;
  publiclyAvailable: boolean;
  title?: string;
  bodyMarkdown?: string;
  bodyHtml?: string;
}

interface Data {
  reviewId: string;
  currentPublishedRevisionId: string | null;
  canReadBodies: boolean;
  publiclyVisible: boolean;
  withdrawn: boolean;
  hidden: boolean;
  total: number;
  revisions: RevisionDto[];
}

/** 一篇公开中的评测：rev1 曾公开（现被取代）、rev2 当前公开、rev3 尚未公开。 */
function seed(): Seed {
  const authorId = insertUser(db, { nickname: '作者' });
  const adminId = insertUser(db, { role: 'admin', nickname: '管理员' });
  const strangerId = insertUser(db, { nickname: '路人' });
  const repositoryId = insertRepository(db);
  const pluginId = insertPlugin(db, repositoryId);
  const reviewId = insertReview(db, { authorId, pluginId });

  const rev1 = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 1, title: '第一版标题', body: '第一版正文' });
  const rev2 = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 2, title: '第二版标题', body: '第二版正文' });
  const rev3 = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 3, title: '第三版标题', body: '尚未公开的正文' });

  const now = Date.now();
  const draftId = newId();
  db.prepare(
    `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, payload_schema_version, save_version, created_at, saved_at)
     VALUES (?, ?, 'review', ?, '{}', 1, 0, ?, ?)`,
  ).run(draftId, authorId, reviewId, now, now);

  const insertSubmission = (revisionId: string, state: string) => {
    const id = newId();
    db.prepare(
      `INSERT INTO content_submissions
         (id, submitted_by, submission_type, review_revision_id, draft_id, draft_save_version,
          request_key, request_digest, processing_state, state_version, publication_context, submitted_at, updated_at)
       VALUES (?, ?, 'review_revision', ?, ?, 0, ?, ?, ?, 0, '{}', ?, ?)`,
    ).run(id, authorId, revisionId, draftId, `req-${id}`, 'a'.repeat(64), state, now, now);
    return id;
  };
  insertSubmission(rev1, 'published');
  insertSubmission(rev2, 'published');
  insertSubmission(rev3, 'pending');

  db.prepare('UPDATE reviews SET published_revision_id = ?, latest_submitted_revision_id = ? WHERE id = ?').run(rev2, rev3, reviewId);
  db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(now, now, reviewId);

  return { reviewId, authorId, adminId, strangerId, rev1, rev2, rev3 };
}

async function sessionToken(userId: string): Promise<string> {
  const identity = createIdentityService({ db });
  return (await identity.createSession(userId, Date.now())).token;
}

async function call(reviewId: string, token: string | null): Promise<{ status: number; raw: string; data: Data | null; code: string | null }> {
  auth.token = token;
  const response = await GET(new Request(`http://localhost/api/reviews/${reviewId}/revisions`), {
    params: Promise.resolve({ reviewId }),
  });
  const raw = await response.text();
  const envelope = JSON.parse(raw) as { ok: boolean; data?: Data; error?: { code: string } };
  return {
    status: response.status,
    raw,
    data: envelope.ok ? (envelope.data ?? null) : null,
    code: envelope.ok ? null : (envelope.error?.code ?? null),
  };
}

describe('修订历史接口', () => {
  it('公开访客只拿到元信息：不含任何标题或正文，且状态标注如实', async () => {
    const s = seed();
    const result = await call(s.reviewId, null);

    expect(result.status).toBe(200);
    const data = result.data as Data;
    expect(data.canReadBodies).toBe(false);
    // `页面布局.md` §6「公开页不展示私有处理进度」：从未公开过的修订对访客**完全不可见** ——
    // 不是"列出但隐藏正文"，而是连"存在一条待审修订"都不暴露。
    // 所以访客只应看到两条曾经公开过的修订（rev1 被取代、rev2 当前公开）。
    expect(data.total).toBe(2);
    expect(data.currentPublishedRevisionId).toBe(s.rev2);

    const byId = new Map(data.revisions.map((r) => [r.revisionId, r]));
    expect(byId.get(s.rev2)?.status).toBe('current');
    expect(byId.get(s.rev2)?.publiclyAvailable).toBe(true);
    expect(byId.get(s.rev1)?.status).toBe('superseded');
    expect(byId.get(s.rev1)?.wasPublished).toBe(true);
    // 待审修订整条不在列表里
    expect(byId.has(s.rev3)).toBe(false);

    // 正文/标题一个都不许出现 —— 直接对整个响应文本断言，防止"换个字段名绕过去"。
    for (const revision of data.revisions) {
      expect(Object.prototype.hasOwnProperty.call(revision, 'title')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(revision, 'bodyMarkdown')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(revision, 'bodyHtml')).toBe(false);
    }
    expect(result.raw).not.toContain('第三版标题');
    expect(result.raw).not.toContain('尚未公开的正文');
    expect(result.raw).not.toContain('第二版正文');
    expect(result.raw).not.toContain('第一版正文');
    // 审核阶段（pending/published 这些内部键）同样不下发。
    expect(result.raw).not.toContain('pending');
    expect(result.raw).not.toContain('processing');
  });

  it('作者本人拿到全部修订的标题与正文（含净化后的 HTML）', async () => {
    const s = seed();
    const token = await sessionToken(s.authorId);
    const result = await call(s.reviewId, token);

    expect(result.status).toBe(200);
    const data = result.data as Data;
    expect(data.canReadBodies).toBe(true);

    const unpublished = data.revisions.find((r) => r.revisionId === s.rev3) as RevisionDto;
    expect(unpublished.title).toBe('第三版标题');
    expect(unpublished.bodyMarkdown).toBe('尚未公开的正文');
    expect(unpublished.bodyHtml).toContain('<p>');
    expect(unpublished.bodyHtml).toContain('尚未公开的正文');

    const superseded = data.revisions.find((r) => r.revisionId === s.rev1) as RevisionDto;
    expect(superseded.bodyMarkdown).toBe('第一版正文');
  });

  it('管理员（非作者）同样能拿到历史正文', async () => {
    const s = seed();
    const token = await sessionToken(s.adminId);
    const result = await call(s.reviewId, token);

    expect(result.status).toBe(200);
    const data = result.data as Data;
    expect(data.canReadBodies).toBe(true);
    expect(data.revisions.every((r) => typeof r.bodyMarkdown === 'string')).toBe(true);
  });

  it('其他登录用户与匿名访客待遇相同：没有正文', async () => {
    const s = seed();
    const token = await sessionToken(s.strangerId);
    const result = await call(s.reviewId, token);

    expect(result.status).toBe(200);
    expect((result.data as Data).canReadBodies).toBe(false);
    expect(result.raw).not.toContain('尚未公开的正文');
  });

  it('评测不存在 → 404（target_unavailable）', async () => {
    const result = await call(newId(), null);
    expect(result.status).toBe(404);
    expect(result.code).toBe('target_unavailable');
  });

  it('文章撤回后：匿名 404（不泄露私有历史），作者仍能查看自己文章的修订列表', async () => {
    const s = seed();
    db.prepare(
      `UPDATE content_entities
          SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1
        WHERE id = ?`,
    ).run(Date.now(), '作者撤回', s.reviewId);

    const anonymous = await call(s.reviewId, null);
    expect(anonymous.status).toBe(404);
    expect(anonymous.raw).not.toContain('第二版正文');

    const authorToken = await sessionToken(s.authorId);
    const mine = await call(s.reviewId, authorToken);
    expect(mine.status).toBe(200);
    const data = mine.data as Data;
    expect(data.withdrawn).toBe(true);
    expect(data.publiclyVisible).toBe(false);
    expect(data.revisions.every((r) => r.publiclyAvailable === false)).toBe(true);
    expect(data.revisions.every((r) => r.isWithdrawn)).toBe(true);
  });
});