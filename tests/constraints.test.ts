/**
 * 约束与迁移测试（工作包 GF）。
 *
 * 每条测试都必须在实现被破坏时变红：
 *  - 删掉 CHECK / 触发器 → 对应用例失败；
 *  - 关掉 PRAGMA foreign_keys → 外键用例失败。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTestDb,
  expectSqliteError,
  insertPlugin,
  insertReply,
  insertRepository,
  insertReview,
  insertReviewRevision,
  insertRootComment,
  insertUser,
  type TestDb,
} from './support/db';
import { newId } from '../src/server/platform/id';
import { selfCheck, REQUIRED_TABLES, migrate } from '../src/server/platform/migrate';
import { digest } from '../src/server/platform/digest';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

describe('迁移与启动自检', () => {
  it('空库可初始化：迁移后自检通过，外键开启，WAL 生效', () => {
    const { db } = setup();
    const check = selfCheck(db);
    expect(check.ok).toBe(true);
    expect(check.foreignKeys).toBe(true);
    expect(check.journalMode).toBe('wal');
    expect(check.missingTables).toEqual([]);
    expect(check.problems).toEqual([]);
  });

  it('必需业务表全部真实存在于 sqlite_master（不是声称存在）', () => {
    const { db } = setup();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of REQUIRED_TABLES) {
      expect(names, `缺少表 ${t}`).toContain(t);
    }
  });

  it('外键在连接上真实启用；关闭外键会让本用例失败', () => {
    const { db } = setup();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('盖楼与不可变触发器真实进入了迁移（查 sqlite_master，不靠文档声称）', () => {
    const { db } = setup();
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(triggers).toContain('trg_comments_reply_group_insert');
    expect(triggers).toContain('trg_review_revisions_immutable');
    expect(triggers).toContain('trg_comment_revisions_immutable');
    expect(triggers).toContain('trg_attempts_no_rewrite_after_finish');
    expect(triggers).toContain('trg_submissions_snapshot_owner_insert');
  });

  it('迁移幂等：重复执行不重跑已应用文件', () => {
    const c = setup();
    const again = migrate({ db: c.db, file: c.file });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied.length).toBe(2);
  });
});

describe('外键与归属约束', () => {
  it('未知用户的外键被拒绝', () => {
    const { db } = setup();
    const msg = expectSqliteError(() =>
      db
        .prepare(
          `INSERT INTO external_identities (id, user_id, provider, provider_user_id, provider_username, profile_url, created_at, synced_at)
           VALUES (?, ?, 'github', '1', 'ghost', 'https://github.com/ghost', ?, ?)`,
        )
        .run(newId(), newId(), Date.now(), Date.now()),
    );
    expect(msg).toMatch(/FOREIGN KEY/i);
  });

  it('孤立父记录被拒绝：公共实体回指一个不存在的评测 ID', () => {
    const { db } = setup();
    const user = insertUser(db);
    const bogus = newId();
    // 关键：这是**延迟**外键的测试。子表先插、父表应当后插；事务提交时若父行仍不存在，
    // 延迟外键必须在 commit 时报错。若外键被去掉或没标 DEFERRABLE，本用例会失败。
    const msg = expectSqliteError(() => {
      const run = db.transaction(() => {
        db.prepare(
          `INSERT INTO content_entities (id, content_type, author_id, review_id, created_at)
           VALUES (?, 'review', ?, ?, ?)`,
        ).run(bogus, user, bogus, Date.now());
        // 故意不插入对应的 reviews 行
      });
      run();
    });
    expect(msg).toMatch(/FOREIGN KEY/i);
  });

  it('延迟配对在正确顺序下可以提交（证明约束不是靠"永远失败"通过的）', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const id = newId();
    // 先插公共实体（回指自身），再插具体子表 —— 同一事务内顺序颠倒也必须成功。
    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO content_entities (id, content_type, author_id, review_id, created_at)
         VALUES (?, 'review', ?, ?, ?)`,
      ).run(id, user, id, Date.now());
      db.prepare(`INSERT INTO reviews (id, plugin_id, source_kind) VALUES (?, ?, 'community')`).run(id, plugin);
    });
    run();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect((db.prepare('SELECT count(*) c FROM reviews WHERE id = ?').get(id) as { c: number }).c).toBe(1);
  });

  it('错误子类型被拒绝：本切片不允许写入没有具体子表承接的 pack_release 公共记录', () => {
    const { db } = setup();
    const user = insertUser(db);
    const id = newId();
    // 本切片未建 plugin_pack_releases。若不在基线里拦住，这条记录会变成没有内容的孤儿行。
    const msg = expectSqliteError(() => {
      const run = db.transaction(() => {
        db.prepare(
          `INSERT INTO content_entities (id, content_type, author_id, review_id, pack_release_id, created_at)
           VALUES (?, 'pack_release', ?, NULL, ?, ?)`,
        ).run(id, user, id, Date.now());
      });
      run();
    });
    // 放开 pack_release 时必须同时建立子表并改掉这条断言 —— 这就是切片闸门。
    expect(msg).toMatch(/content_type = 'review'/);
    expect((db.prepare('SELECT count(*) c FROM content_entities WHERE id = ?').get(id) as { c: number }).c).toBe(0);
  });

  it('正确的延迟配对可以提交（证明约束不是靠"永远失败"通过的）', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewId = insertReview(db, { authorId: user, pluginId: plugin });
    const row = db.prepare('SELECT content_type, review_id FROM content_entities WHERE id = ?').get(reviewId) as {
      content_type: string;
      review_id: string;
    };
    expect(row.content_type).toBe('review');
    expect(row.review_id).toBe(reviewId);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('公共内容类型不可变更', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewId = insertReview(db, { authorId: user, pluginId: plugin });
    const msg = expectSqliteError(() =>
      db.prepare(`UPDATE content_entities SET content_type = 'pack_release' WHERE id = ?`).run(reviewId),
    );
    expect(msg).toMatch(/类型不可变更/);
  });

  it('同一仓库同一子路径只产生一个插件；不同子路径分别保留', () => {
    const { db } = setup();
    const repo = insertRepository(db, 'gh-fixed-1');
    insertPlugin(db, repo, '.');
    const msg = expectSqliteError(() => insertPlugin(db, repo, '.'));
    expect(msg).toMatch(/UNIQUE/i);

    // 不同子路径不冲突
    const sub = insertPlugin(db, repo, 'packages/alpha');
    expect(sub).toBeTruthy();

    // 不同仓库同名路径不冲突
    const repo2 = insertRepository(db, 'gh-fixed-2');
    expect(insertPlugin(db, repo2, '.')).toBeTruthy();
  });

  it('评测修订的插件归属必须与文章公开修订一致（架构第 34.1 节）', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const pluginA = insertPlugin(db, repo, '.');
    const pluginB = insertPlugin(db, repo, 'packages/beta');
    const reviewId = insertReview(db, { authorId: user, pluginId: pluginA });
    const rev = insertReviewRevision(db, { reviewId, pluginId: pluginA, revisionNumber: 1 });

    // 正常：文章关联 = 修订关联
    db.prepare(`UPDATE reviews SET published_revision_id = ? WHERE id = ?`).run(rev, reviewId);
    expect(
      (db.prepare('SELECT published_revision_id AS r FROM reviews WHERE id = ?').get(reviewId) as { r: string }).r,
    ).toBe(rev);

    // 异常：修订属于另一插件
    const revB = insertReviewRevision(db, { reviewId, pluginId: pluginB, revisionNumber: 2 });
    const msg = expectSqliteError(() =>
      db.prepare(`UPDATE reviews SET published_revision_id = ? WHERE id = ?`).run(revB, reviewId),
    );
    expect(msg).toMatch(/插件关联与文章当前关联不一致|不属于本篇评测/);
  });

  it('公开修订指针不能指向别的文章的修订', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewA = insertReview(db, { authorId: user, pluginId: plugin });
    const reviewB = insertReview(db, { authorId: user, pluginId: plugin });
    const revB = insertReviewRevision(db, { reviewId: reviewB, pluginId: plugin, revisionNumber: 1 });
    const msg = expectSqliteError(() =>
      db.prepare(`UPDATE reviews SET published_revision_id = ? WHERE id = ?`).run(revB, reviewA),
    );
    expect(msg).toMatch(/不属于本篇评测/);
  });
});

describe('评论盖楼归属（架构第 79.1 节）', () => {
  it('被回复对象与 root 必须同属一个公共内容', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewA = insertReview(db, { authorId: user, pluginId: plugin });
    const reviewB = insertReview(db, { authorId: user, pluginId: plugin });
    const rootA = insertRootComment(db, { contentEntityId: reviewA, authorId: user });

    // 跨对象回复被拒
    const msg = expectSqliteError(() =>
      insertReply(db, { contentEntityId: reviewB, authorId: user, replyTo: rootA, root: rootA }),
    );
    expect(msg).toMatch(/不属于同一公共内容/);
  });

  it('root 必须指向真正的顶层评论，不能指向另一条回复', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const review = insertReview(db, { authorId: user, pluginId: plugin });
    const root = insertRootComment(db, { contentEntityId: review, authorId: user });
    const reply1 = insertReply(db, { contentEntityId: review, authorId: user, replyTo: root, root });

    // 把 reply1 当作 root
    const msg = expectSqliteError(() =>
      insertReply(db, { contentEntityId: review, authorId: user, replyTo: root, root: reply1 }),
    );
    expect(msg).toMatch(/必须指向顶层评论|讨论组不一致/);
  });

  it('回复回复时 root 沿用原顶层，且关系创建后不可修改', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const review = insertReview(db, { authorId: user, pluginId: plugin });
    const root = insertRootComment(db, { contentEntityId: review, authorId: user });
    const reply1 = insertReply(db, { contentEntityId: review, authorId: user, replyTo: root, root });
    // 回复 reply1，root 仍是 root
    const reply2 = insertReply(db, { contentEntityId: review, authorId: user, replyTo: reply1, root });
    const row = db.prepare('SELECT root_comment_id AS r FROM comments WHERE id = ?').get(reply2) as { r: string };
    expect(row.r).toBe(root);

    // 试图把 reply2 迁移到另一讨论组
    const other = insertRootComment(db, { contentEntityId: review, authorId: user });
    const msg = expectSqliteError(() =>
      db.prepare('UPDATE comments SET root_comment_id = ? WHERE id = ?').run(other, reply2),
    );
    expect(msg).toMatch(/创建后不可修改/);
  });

  it('顶层评论两个回复关联必须为空；回复两者必须非空且不能指自己', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const review = insertReview(db, { authorId: user, pluginId: plugin });

    // 只有 reply_to 没有 root：触发器先报「root 不属于同一公共内容」（root 为 NULL），
    // 但无论走哪条路径，结果都必须是**被拒绝**——绝不允许半截回复落库。
    const id1 = newId();
    const target = insertRootComment(db, { contentEntityId: review, authorId: user });
    const msg1 = expectSqliteError(() =>
      db
        .prepare(
          `INSERT INTO comments (id, content_entity_id, author_id, reply_to_comment_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id1, review, user, target, Date.now()),
    );
    expect(msg1).toMatch(/root_comment_id 不属于同一公共内容|CHECK|FOREIGN KEY/i);
    expect((db.prepare('SELECT count(*) c FROM comments WHERE id = ?').get(id1) as { c: number }).c).toBe(0);

    // 两个都填但自指：必须被拒绝（CHECK 的 <> id 条件或触发器先命中，都算通过）
    const id2 = newId();
    const msg2 = expectSqliteError(() =>
      db
        .prepare(
          `INSERT INTO comments (id, content_entity_id, author_id, reply_to_comment_id, root_comment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id2, review, user, id2, id2, Date.now()),
    );
    expect(msg2).toMatch(/CHECK|不属于同一公共内容|FOREIGN KEY/i);
    expect((db.prepare('SELECT count(*) c FROM comments WHERE id = ?').get(id2) as { c: number }).c).toBe(0);
  });
});

describe('不可变快照', () => {
  it('评测修订提交后不可改写、不可删除', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const review = insertReview(db, { authorId: user, pluginId: plugin });
    const rev = insertReviewRevision(db, { reviewId: review, pluginId: plugin, revisionNumber: 1 });

    const msgU = expectSqliteError(() =>
      db.prepare('UPDATE review_revisions SET title = ? WHERE id = ?').run('改标题', rev),
    );
    expect(msgU).toMatch(/不可改写/);

    const msgD = expectSqliteError(() => db.prepare('DELETE FROM review_revisions WHERE id = ?').run(rev));
    expect(msgD).toMatch(/不可删除/);
  });

  it('评论修订与已完成的任务执行记录同样不可改写', () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const review = insertReview(db, { authorId: user, pluginId: plugin });
    const comment = insertRootComment(db, { contentEntityId: review, authorId: user });

    const revId = newId();
    db.prepare(
      `INSERT INTO comment_revisions (id, comment_id, revision_number, body, submitted_at) VALUES (?, ?, 1, ?, ?)`,
    ).run(revId, comment, '评论正文', Date.now());
    const msg = expectSqliteError(() =>
      db.prepare('UPDATE comment_revisions SET body = ? WHERE id = ?').run('改', revId),
    );
    expect(msg).toMatch(/不可改写/);
  });
});

describe('任务执行权结构约束', () => {
  function insertTask(db: TestDb['db'], state: string, extra: Record<string, unknown> = {}): string {
    const id = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO background_tasks
        (id, task_type, deduplication_key, payload, scheduling_group, processing_state, available_at,
         lease_owner, lease_expires_at, execution_token, created_at, updated_at, finished_at)
       VALUES (?, 'review_check', ?, '{}', 'g', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      String(extra.dedup ?? newId()),
      state,
      now,
      (extra.leaseOwner as string) ?? null,
      (extra.leaseExpiresAt as number) ?? null,
      (extra.token as string) ?? null,
      now,
      now,
      (extra.finishedAt as number) ?? null,
    );
    return id;
  }

  it('running 必须同时具备执行权三字段；queued 必须全空', () => {
    const { db } = setup();
    expect(insertTask(db, 'queued')).toBeTruthy();

    const msg = expectSqliteError(() => insertTask(db, 'running'));
    expect(msg).toMatch(/CHECK/i);

    expect(
      insertTask(db, 'running', { leaseOwner: 'w1', leaseExpiresAt: Date.now() + 60_000, token: newId() }),
    ).toBeTruthy();
  });

  it('终态必须有结束时间，进行中必须没有', () => {
    const { db } = setup();
    const msg = expectSqliteError(() => insertTask(db, 'succeeded'));
    expect(msg).toMatch(/CHECK/i);
    expect(insertTask(db, 'succeeded', { finishedAt: Date.now() })).toBeTruthy();
  });

  it('同类型同去重键只允许一条任务', () => {
    const { db } = setup();
    const key = 'review:abc:check';
    insertTask(db, 'queued', { dedup: key });
    const msg = expectSqliteError(() => insertTask(db, 'queued', { dedup: key }));
    expect(msg).toMatch(/UNIQUE/i);
  });
});

describe('摘要工具（请求去重的前提）', () => {
  it('稳定序列化不受键顺序影响', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
  });
  it('内容不同则摘要不同', () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });
});

describe('迁移文件确实包含关键约束（防"被悄悄简化"）', () => {
  it('基线 SQL 里存在 foreign_keys 开启、延迟外键与部分唯一索引', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations', '0001_baseline.sql'), 'utf8');
    expect(sql).toMatch(/PRAGMA foreign_keys = ON/);
    expect(sql).toMatch(/UNIQUE \(review_id, revision_number\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_drafts_review .* WHERE draft_type = 'review'/);
    expect(sql).toMatch(/CHECK \(json_valid\(plugin_version\)\)/);
    // 不允许出现关闭外键的写法
    expect(sql).not.toMatch(/foreign_keys\s*=\s*OFF/i);
  });

  it('触发器 SQL 里没有用关外键绕过写入顺序的写法', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations', '0002_triggers.sql'), 'utf8');
    expect(sql).not.toMatch(/PRAGMA\s+foreign_keys\s*=\s*OFF/i);
    expect(sql).toMatch(/RAISE\(ABORT/);
  });
});
