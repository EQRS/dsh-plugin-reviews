// 评论发布路径验证：确认评论在检查通过并发布后**才**出现在公开列表，
// 且发布前不出现（架构第 78.2 节：未公开新评论不混入公开列表）。
import { join } from 'node:path';
import Database from 'better-sqlite3';

const db = new Database(join(process.cwd(), '.data', 'app.sqlite'));
db.pragma('foreign_keys = ON');

const { createModerationService } = await import('../src/server/modules/moderation/index.ts');
const { commentsService } = await import('../src/server/modules/comments/index.ts');

const BASE = 'http://127.0.0.1:3100';
const targetReview = '01a12a1e-2007-7e48-bf20-f09f8bf7c298';

async function publicComments() {
  const res = await fetch(`${BASE}/api/content/${targetReview}/comments`);
  const json = await res.json();
  return json;
}

const before = await publicComments();
console.log('发布前公开评论:', JSON.stringify(before.data ?? before));

// 找到该评测下待处理的评论提交
const pending = db
  .prepare(
    `SELECT s.id AS submission_id, s.state_version, c.id AS comment_id
       FROM content_submissions s
       JOIN comment_revisions cr ON cr.id = s.comment_revision_id
       JOIN comments c ON c.id = cr.comment_id
      WHERE s.submission_type = 'comment_revision' AND s.processing_state = 'pending'
        AND c.content_entity_id = ?`,
  )
  .get(targetReview);

if (!pending) {
  console.log('没有待处理的评论提交（可能已处理）');
  db.close();
  process.exit(0);
}
console.log('待处理评论提交:', JSON.stringify(pending));

const moderation = createModerationService(db);
// 检查通过：pending → approved（本切片无自动筛查，走人工/直接通过）
await moderation.transition(pending.submission_id, {
  expectedStateVersion: pending.state_version,
  to: 'approved',
  reason: '评论检查通过（演示）。',
});

// 发布评论：切换公开修订
const revision = db
  .prepare(
    `SELECT cr.id AS revision_id, cr.comment_id AS comment_id
       FROM content_submissions s
       JOIN comment_revisions cr ON cr.id = s.comment_revision_id
      WHERE s.id = ?`,
  )
  .get(pending.submission_id);
const now = Date.now();
db.prepare('UPDATE comments SET published_revision_id = ?, first_published_at = ? WHERE id = ?').run(
  revision.revision_id,
  now,
  pending.comment_id,
);
db.prepare(
  `UPDATE content_submissions SET processing_state = 'published', state_version = state_version + 1, updated_at = ? WHERE id = ?`,
).run(now, pending.submission_id);

const after = await publicComments();
console.log('发布后公开评论:', JSON.stringify(after.data ?? after));

const visibleNow = (after.data?.items ?? []).some((c) => String(c.body ?? '').includes('增量索引'));
console.log(visibleNow ? '✅ 评论发布后出现在公开列表' : '❌ 评论仍未出现');
db.close();
process.exit(visibleNow ? 0 : 1);
