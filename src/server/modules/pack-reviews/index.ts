/**
 * 整合包测评：对象是整合包版本（plugin_pack_releases），与 C 路线一致。
 * 与插件测评分开存表；当前直接发布，后续接审核。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, type CallerContext } from '@/server/platform/context';

export interface PackReviewSummary {
  reviewId: string;
  packId: string;
  packTitle: string;
  releaseId: string;
  releaseNumber: number | null;
  authorId: string;
  authorNickname: string | null;
  title: string;
  verdict: string | null;
  assessmentLevel: string | null;
  createdAt: number;
}

export interface PackReviewDetail extends PackReviewSummary {
  bodyMarkdown: string;
  dshVersion: string;
  evidenceRefs: string | null;
  withdrawnAt: number | null;
}

export function createPackReviewsService(options: { db?: SqliteDatabase } = {}) {
  const db = options.db ?? getDb();

  return {
    async createPackReview(
      ctx: CallerContext,
      input: {
        releaseId: string;
        title: string;
        bodyMarkdown: string;
        dshVersion: string;
        verdict?: string | null;
        assessmentLevel?: string | null;
        evidenceRefs?: string | null;
      },
      injectedDb?: SqliteDatabase,
    ): Promise<{ reviewId: string }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const body = typeof input.bodyMarkdown === 'string' ? input.bodyMarkdown.trim() : '';
      if (title.length === 0 || title.length > 120) {
        throw err.input('测评标题需为 1-120 个字。', [{ path: 'title', message: '长度不合法' }]);
      }
      if (body.length === 0) {
        throw err.input('测评正文不能为空。', [{ path: 'bodyMarkdown', message: '必填' }]);
      }
      let dshVersion: unknown;
      try {
        dshVersion = JSON.parse(input.dshVersion);
      } catch {
        throw err.input('DSH 版本格式不正确。', [{ path: 'dshVersion', message: '必须是 JSON' }]);
      }
      if (typeof dshVersion !== 'object' || dshVersion === null) {
        throw err.input('DSH 版本格式不正确。', [{ path: 'dshVersion', message: '必须是对象' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const release = conn
          .prepare(
            `SELECT rel.id
               FROM plugin_pack_releases rel
               JOIN content_entities ce ON ce.id = rel.id
              WHERE rel.id = ?
                AND rel.release_number IS NOT NULL
                AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL`,
          )
          .get(input.releaseId) as { id: string } | undefined;
        if (!release) throw err.unavailable('整合包版本不存在或已不可访问。');

        const reviewId = newId();
        const revisionId = newId();
        const now = nowMs();
        conn
          .prepare(
            `INSERT INTO content_entities (id, content_type, author_id, review_id, created_at)
             VALUES (?, 'review', ?, ?, ?)`,
          )
          .run(reviewId, userId, reviewId, now);
        conn.prepare('INSERT INTO reviews (id, plugin_id) VALUES (?, NULL)').run(reviewId);
        conn
          .prepare('INSERT INTO pack_reviews (id, release_id, created_at) VALUES (?, ?, ?)')
          .run(reviewId, input.releaseId, now);
        conn
          .prepare(
            `INSERT INTO pack_review_revisions
               (id, review_id, revision_number, release_id, title, body_markdown, dsh_version,
                verdict, evidence_refs, assessment_level, submitted_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revisionId,
            reviewId,
            input.releaseId,
            title,
            body,
            input.dshVersion,
            input.verdict ?? null,
            input.evidenceRefs ?? null,
            input.assessmentLevel ?? null,
            now,
          );
        conn
          .prepare(
            `UPDATE pack_reviews
                SET published_revision_id = ?, latest_submitted_revision_id = ?
              WHERE id = ?`,
          )
          .run(revisionId, revisionId, reviewId);
        return { reviewId };
      }, injectedDb ?? db);
    },

    async listPackReviews(_ctx: CallerContext, q?: string, injectedDb?: SqliteDatabase): Promise<PackReviewSummary[]> {
      const keyword = (q ?? '').trim();
      const like = keyword ? '%' + keyword.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : null;
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT pr.id AS review_id, rel.pack_id, rel.title AS pack_title,
                    rel.id AS release_id, rel.release_number,
                    ce.author_id, u.nickname, rev.title, rev.verdict, rev.assessment_level,
                    rev.submitted_at AS created_at
               FROM pack_reviews pr
               JOIN plugin_pack_releases rel ON rel.id = pr.release_id
               JOIN pack_review_revisions rev ON rev.id = pr.published_revision_id
               JOIN content_entities ce ON ce.id = pr.id
               JOIN users u ON u.id = ce.author_id
              WHERE pr.published_revision_id IS NOT NULL
                AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL
                AND rel.release_number IS NOT NULL
                AND (? IS NULL OR rev.title LIKE ? ESCAPE '\\')
              ORDER BY rev.submitted_at DESC, pr.id DESC
              LIMIT 100`,
          )
          .all(like, like) as Array<{
          review_id: string;
          pack_id: string;
          pack_title: string;
          release_id: string;
          release_number: number | null;
          author_id: string;
          nickname: string;
          title: string;
          verdict: string | null;
          assessment_level: string | null;
          created_at: number;
        }>;
        return rows.map((r) => ({
          reviewId: r.review_id,
          packId: r.pack_id,
          packTitle: r.pack_title,
          releaseId: r.release_id,
          releaseNumber: r.release_number,
          authorId: r.author_id,
          authorNickname: r.nickname,
          title: r.title,
          verdict: r.verdict,
          assessmentLevel: r.assessment_level,
          createdAt: r.created_at,
        }));
      }, injectedDb ?? db);
    },

    async getPackReview(_ctx: CallerContext, reviewId: string, injectedDb?: SqliteDatabase): Promise<PackReviewDetail> {
      return withRead((conn) => {
        const row = conn
          .prepare(
            `SELECT pr.id AS review_id, rel.pack_id, rel.title AS pack_title,
                    rel.id AS release_id, rel.release_number,
                    ce.author_id, u.nickname, ce.withdrawn_at,
                    rev.title, rev.body_markdown, rev.dsh_version, rev.verdict,
                    rev.evidence_refs, rev.assessment_level, rev.submitted_at AS created_at
               FROM pack_reviews pr
               JOIN plugin_pack_releases rel ON rel.id = pr.release_id
               JOIN pack_review_revisions rev ON rev.id = pr.published_revision_id
               JOIN content_entities ce ON ce.id = pr.id
               JOIN users u ON u.id = ce.author_id
              WHERE pr.id = ?`,
          )
          .get(reviewId) as
          | {
              review_id: string;
              pack_id: string;
              pack_title: string;
              release_id: string;
              release_number: number | null;
              author_id: string;
              nickname: string;
              withdrawn_at: number | null;
              title: string;
              body_markdown: string;
              dsh_version: string;
              verdict: string | null;
              evidence_refs: string | null;
              assessment_level: string | null;
              created_at: number;
            }
          | undefined;
        if (!row) throw err.unavailable('测评不存在或已不可访问。');
        if (row.withdrawn_at !== null) throw err.unavailable('测评不存在或已不可访问。');
        return {
          reviewId: row.review_id,
          packId: row.pack_id,
          packTitle: row.pack_title,
          releaseId: row.release_id,
          releaseNumber: row.release_number,
          authorId: row.author_id,
          authorNickname: row.nickname,
          title: row.title,
          bodyMarkdown: row.body_markdown,
          dshVersion: row.dsh_version,
          verdict: row.verdict,
          evidenceRefs: row.evidence_refs,
          assessmentLevel: row.assessment_level,
          createdAt: row.created_at,
          withdrawnAt: row.withdrawn_at,
        };
      }, injectedDb ?? db);
    },
  };
}

export type PackReviewsService = ReturnType<typeof createPackReviewsService>;
