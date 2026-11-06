/**
 * 迁移层：0037 / 0038 与主线的并集口径（W1）。
 *
 * 这个文件只测 **迁移产出的库结构**，不碰服务层——迁移是地基，服务层测试再多也
 * 不能在迁移把列或索引弄丢时报警。三条钉住的不变量：
 *
 * 1. 0037 重建 notifications 时，kind 列表 / link_url 列 / 两条 CHECK 分组必须是
 *    0034（精选订阅）+ 0036（问题反馈）+ 0037（讨论区）的**并集**。只照搬 0016 的旧口径
 *    会把 featured_published / feedback_result 与 link_url 一起删掉，精选发布与反馈结果的
 *    站内通知整条链路静默失效（表现为 "table notifications has no column named link_url"）。
 * 2. reports.detail 的上限与接口 / UI 一致，是 2000 而不是 1000。
 * 3. 举报去重对**每一类**目标都真实生效。四列平铺进同一个唯一索引键时，因为每行恰好
 *    一类目标列非空、其余为 NULL，而 SQLite 唯一索引视 NULL 互不相等，对五类目标全部失效。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, insertUser, insertPlugin, insertRepository, insertReview, type TestDb } from './support/db';
import { newId } from '../src/server/platform/id';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

/**
 * 0037 重建的是 0034 + 0036 + 0037 的并集，它的 `INSERT ... SELECT link_url` 要求源表
 * 已经有这一列——**这个列由 0034 提供**。本仓库当前的工作分支还没合入 0034/0036 时，
 * 0037 单独跑必然报 "no such column: link_url"（缺上游迁移，不是 0037 的缺陷）。
 * 那种情况下本文件整体跳过，并在用例名里说明，而不是抛一串看不出原因的失败。
 */
const HAS_UPSTREAM_FEATURED = [
  '0034_featured_subscriptions.sql',
  '0036_feedback_tickets.sql',
].every((f) => existsSync(join(process.cwd(), 'migrations', f)));
const describeWithUpstream = HAS_UPSTREAM_FEATURED ? describe : describe.skip;

function setup(): TestDb & { alice: string; bob: string; carol: string } {
  ctx = createTestDb();
  const db = ctx.db;
  const alice = insertUser(db);
  const bob = insertUser(db);
  const carol = insertUser(db);
  return { ...ctx, alice, bob, carol };
}

/** 读表的建表 SQL（CHECK 约束都在这里）。 */
function tableSql(db: TestDb['db'], table: string): string {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string } | undefined;
  expect(row, `表 ${table} 不存在`).toBeTruthy();
  return (row as { sql: string }).sql;
}

/** 从 `kind IN (...)` 里抽出 kind 清单。 */
function kindsIn(sql: string): string[] {
  const m = /kind\s+TEXT\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql);
  expect(m, 'notifications 上找不到 kind 的 CHECK').not.toBeNull();
  return (m as RegExpExecArray)[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
}

describeWithUpstream('迁移 0037：notifications 重建取并集，不丢 0034/0036 加的列与 kind', () => {
  it('notifications 有 link_url 列（0034 加的）', () => {
    const { db } = setup();
    const cols = (db.prepare("SELECT name FROM pragma_table_info('notifications')").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain('link_url');
  });

  it('kind 列表是 0034 + 0036 + 0037 的并集', () => {
    const { db } = setup();
    // 0037 这一份只负责"不丢 0034/0036 加的东西"。后面的迁移会继续扩 kind
    // （0041 加了 role_application_result / plugin_claim_result），所以这里判**包含**，
    // 判等会让每加一个 kind 都要回来改一次这条用例。
    const kinds = kindsIn(tableSql(db, 'notifications'));
    for (const kind of [
      'comment_on_content',
      'reply_to_comment',
      'moderation_result',
      'featured_published',
      'feedback_result',
      'forum_reply',
      'forum_reply_to_reply',
      'forum_board_application',
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it('featured_published / feedback_result 能落库，并写进 link_url（列还在只是"能建表"不够）', () => {
    const { db, alice, bob } = setup();
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO notifications
         (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)`,
    );

    for (const [kind, link] of [
      ['featured_published', '/featured/1'],
      ['feedback_result', '/feedback/1'],
    ] as const) {
      const id = newId();
      insert.run(id, bob, kind, alice, `k-${id}`, '详情', link, now);
      const row = db.prepare('SELECT link_url, detail FROM notifications WHERE id = ?').get(id) as {
        link_url: string;
        detail: string;
      };
      expect(row.link_url).toBe(link);
    }
  });

  it('detail 必填与 content_entity_id 可空的两条 CHECK 都覆盖到全集（缺 detail 仍被拒）', () => {
    const { db, alice, bob } = setup();
    const now = Date.now();
    const sql = tableSql(db, 'notifications');

    // detail 组：六种"栏目类"通知都要求 detail 非空
    const detailGroup = /CHECK \(\(kind IN \(([^)]*)\)\) = \(detail IS NOT NULL\)\)/.exec(sql);
    expect(detailGroup).not.toBeNull();
    const detailKinds = (detailGroup as RegExpExecArray)[1].replace(/'/g, '').split(', ');
    // 同上：后续迁移会往这一组里加 kind，判包含而不是判等。
    for (const kind of [
      'moderation_result',
      'featured_published',
      'feedback_result',
      'forum_reply',
      'forum_reply_to_reply',
      'forum_board_application',
    ]) {
      expect(detailKinds).toContain(kind);
    }

    // 同一组 kind 也是"允许没有 content_entity_id"的那一组
    const anchorGroup = /CHECK \(kind IN \(([^)]*)\) OR content_entity_id IS NOT NULL\)/.exec(sql);
    expect(anchorGroup).not.toBeNull();
    const anchorKinds = (anchorGroup as RegExpExecArray)[1].replace(/'/g, '').split(', ');
    // 两条约束必须覆盖同一组 kind（一个说"这类必须有 detail"，一个说"这类可以没有 content_entity_id"）。
    expect([...anchorKinds].sort()).toEqual([...detailKinds].sort());

    // 反向：featured_published 不带 detail 必须被拒（不能因为并集把约束写松）
    expect(() =>
      db
        .prepare(
          `INSERT INTO notifications
             (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at)
           VALUES (?, ?, 'featured_published', ?, NULL, NULL, ?, NULL, '/x', NULL, ?)`,
        )
        .run(newId(), bob, alice, 'k-null-detail', now),
    ).toThrow(/CHECK/);
  });
});

describeWithUpstream('迁移 0038：reports.detail 上限与接口 / UI 一致', () => {
  it('2000 字可落库、2001 被拒（与 interactions 校验和前端计数一致）', () => {
    const db = setup().db;
    const now = Date.now();
    const reporter = insertUser(db);
    const pluginId = insertPlugin(db, insertRepository(db));
    const reviewId = insertReview(db, { authorId: reporter, pluginId });

    const insert = (id: string, detail: string) =>
      db
        .prepare(
          `INSERT INTO reports
             (id, reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason, detail, state, created_at)
           VALUES (?, ?, 'review', ?, NULL, NULL, NULL, 'spam', ?, 'open', ?)`,
        )
        .run(id, reporter, reviewId, detail, now);

    expect(() => insert(newId(), 'x'.repeat(2000))).not.toThrow();
    expect(() => insert(newId(), 'x'.repeat(2001))).toThrow(/CHECK/);
  });
});

describeWithUpstream('迁移 0038：举报去重对每一类目标真实生效', () => {
  /**
   * 断言「同人 + 同目标 + 同原因」第二次被唯一索引拒掉，而换目标 / 换人 / 换原因都还能报。
   * 这一组用例在四列平铺的旧索引下会整组失败（NULL 互不相等 → 谁都不算重复）。
   */
  function expectDedup(insert: (id: string, reason?: string, reporter?: string) => void, extra: () => void) {
    insert(newId());
    expect(() => insert(newId())).toThrow(/UNIQUE/);
    expect(() => insert(newId(), 'abuse')).not.toThrow(); // 换原因
    extra();
  }

  it('review 目标：同一评测同人同原因只能有一条 open 举报', () => {
    const { db, alice, bob } = setup();
    const now = Date.now();
    const reviewId = insertReview(db, { authorId: alice, pluginId: insertPlugin(db, insertRepository(db)) });
    const insert = (id: string, reason = 'spam', reporter = bob) =>
      db
        .prepare(
          `INSERT INTO reports
             (id, reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason, detail, state, created_at)
           VALUES (?, ?, 'review', ?, NULL, NULL, NULL, ?, NULL, 'open', ?)`,
        )
        .run(id, reporter, reviewId, reason, now);

    expectDedup(insert, () => {
      expect(() => insert(newId(), 'spam', alice)).not.toThrow(); // 换人
      // 已处理（非 open）后可以再报
      db.prepare("UPDATE reports SET state = 'resolved'").run();
      expect(() => insert(newId())).not.toThrow();
    });
  });

  it('comment 目标：去重键落在 comment_id 上，同一内容实体下的不同评论互不干扰', () => {
    const { db, alice, bob } = setup();
    const now = Date.now();
    const reviewId = insertReview(db, { authorId: alice, pluginId: insertPlugin(db, insertRepository(db)) });
    const commentIds = [newId(), newId()];
    for (const commentId of commentIds) {
      db.prepare('INSERT INTO comments (id, content_entity_id, author_id, created_at) VALUES (?, ?, ?, ?)').run(
        commentId,
        reviewId,
        alice,
        now,
      );
    }
    const insert = (id: string, commentId = commentIds[0], reason = 'spam') =>
      db
        .prepare(
          `INSERT INTO reports
             (id, reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason, detail, state, created_at)
           VALUES (?, ?, 'comment', ?, ?, NULL, NULL, ?, NULL, 'open', ?)`,
        )
        .run(id, bob, reviewId, commentId, reason, now);

    insert(newId());
    expect(() => insert(newId())).toThrow(/UNIQUE/);
    // 关键：0012 的口径是评论目标的 content_entity_id 填**所属内容实体**，
    // 两条不同评论的 content_entity_id 相同——若四列平铺进同一个键，第二条会被误判重复。
    expect(() => insert(newId(), commentIds[1])).not.toThrow();
    expect(() => insert(newId(), commentIds[0], 'abuse')).not.toThrow();
  });

  it('post / forum_reply 目标：各自按自己的列去重，不同目标互不干扰', async () => {
    const { db, alice, bob } = setup();
    const { createForumPostService } = await import('../src/server/modules/forum/posts');
    const { ensureDefaultBoards } = await import('../src/server/modules/forum/boards');
    ensureDefaultBoards(db);
    const posts = createForumPostService({ db });
    const caller = (userId: string) => {
      const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
        role: 'user' | 'admin';
        account_status: 'active' | 'disabled';
      };
      return { userId, role: row.role, accountStatus: row.account_status };
    };
    const { postId: postA } = await posts.createPost(caller(alice), { boardSlug: 'general', title: '帖 A', bodyMd: '正文' });
    const { postId: postB } = await posts.createPost(caller(alice), { boardSlug: 'general', title: '帖 B', bodyMd: '正文' });
    const { replyId: replyA } = await posts.createReply(caller(alice), postA, { bodyMd: '回复 A' });
    const { replyId: replyB } = await posts.createReply(caller(alice), postA, { bodyMd: '回复 B' });
    const now = Date.now();

    const insertPost = (id: string, postId = postA, reason = 'spam') =>
      db
        .prepare(
          `INSERT INTO reports
             (id, reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason, detail, state, created_at)
           VALUES (?, ?, 'post', NULL, NULL, ?, NULL, ?, NULL, 'open', ?)`,
        )
        .run(id, bob, postId, reason, now);

    const insertReply = (id: string, replyId = replyA, reason = 'spam') =>
      db
        .prepare(
          `INSERT INTO reports
             (id, reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason, detail, state, created_at)
           VALUES (?, ?, 'forum_reply', NULL, NULL, NULL, ?, ?, NULL, 'open', ?)`,
        )
        .run(id, bob, replyId, reason, now);

    // post：同一帖子同人同原因不可重复，换帖子 / 换原因可以
    insertPost(newId());
    expect(() => insertPost(newId())).toThrow(/UNIQUE/);
    expect(() => insertPost(newId(), postB)).not.toThrow();
    expect(() => insertPost(newId(), postA, 'abuse')).not.toThrow();

    // forum_reply：同一回复不可重复，换回复可以
    insertReply(newId());
    expect(() => insertReply(newId())).toThrow(/UNIQUE/);
    expect(() => insertReply(newId(), replyB)).not.toThrow();
  });
});
