/**
 * 讨论区 · 发帖自动审核。
 *
 * 规则是纯函数，先穷举测判定；再接一层集成测试，确认被判定的帖子
 * 真的不会进公开列表（否则"审核"只是写了个记录，没人拦）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { screenPost, SCREENING_RULES } from '../src/server/modules/forum/screening';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createSettingsService } from '../src/server/modules/settings';
import type { CallerContext } from '@/server/platform/context';

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

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const alice = insertUser(db);
  ensureDefaultBoards(db);
  return { db, alice, posts: createForumPostService({ db }) };
}

describe('screenPost：纯判定', () => {
  it('正常内容放行', () => {
    const r = screenPost({ title: '大家用哪个整合包', body: '想听听大家的推荐，我之前一直在用默认配置。' });
    expect(r.verdict).toBe('passed');
    expect(r.rule).toBe('');
  });

  it('空内容挡下', () => {
    const r = screenPost({ title: '  ', body: '  ' });
    expect(r.verdict).toBe('blocked');
    expect(r.rule).toBe(SCREENING_RULES.emptyContent);
  });

  it('外链超过 3 个挡下', () => {
    const body = '看这里 https://a.com https://b.com https://c.com https://d.com';
    const r = screenPost({ title: '一堆链接', body });
    expect(r.verdict).toBe('blocked');
    expect(r.rule).toBe(SCREENING_RULES.excessiveLinks);
  });

  it('3 个以内放行', () => {
    const body = '参考 https://a.com 与 https://b.com';
    expect(screenPost({ title: '两个链接', body }).verdict).toBe('passed');
  });

  it('Markdown 图片链接不计入外链', () => {
    const body = '![图](https://cdn.example.com/a.png) 看图';
    expect(screenPost({ title: '带图', body }).verdict).toBe('passed');
  });

  it('违禁词挡下，且不在 detail 里回显命中词', () => {
    const r = screenPost({ title: '出闲置', body: '有意加微信详聊' });
    expect(r.verdict).toBe('blocked');
    expect(r.rule).toBe(SCREENING_RULES.bannedWord);
    // 回显等于教人怎么绕过
    expect(r.detail).not.toContain('加微信');
  });

  it('自定义违禁词生效', () => {
    const r = screenPost({ title: '问个事', body: '这里有个自定义词', bannedWords: ['自定义词'] });
    expect(r.verdict).toBe('blocked');
    expect(r.rule).toBe(SCREENING_RULES.bannedWord);
  });

  it('英文全大写长标题挡下', () => {
    const r = screenPost({ title: 'THIS IS A VERY LONG TITLE', body: '正常正文' });
    expect(r.verdict).toBe('blocked');
    expect(r.rule).toBe(SCREENING_RULES.allCapsTitle);
  });

  it('短的全大写放行（OK 这种不算刷屏）', () => {
    expect(screenPost({ title: 'OK', body: '好的' }).verdict).toBe('passed');
  });

  it('连续重复字符挡下', () => {
    const r = screenPost({ title: '正常标题', body: '啊'.repeat(20) });
    expect(r.verdict).toBe('blocked');
    expect(r.rule).toBe(SCREENING_RULES.repeatedChars);
  });

  it('中文标题不受全大写规则影响', () => {
    expect(screenPost({ title: '求推荐一个稳定的整合包', body: '谢谢' }).verdict).toBe('passed');
  });
});

describe('接入发帖流程', () => {
  it('正常帖子直接发布且进列表', async () => {
    const { db, alice, posts } = setup();
    const r = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '正常帖子',
      bodyMd: '这是一段正常的内容。',
    });
    expect(r.pendingReview).toBe(false);

    const list = await posts.listPosts(caller(db, alice), 'general');
    expect(list.items).toHaveLength(1);
  });

  it('命中规则的帖子压成待审，不进公开列表', async () => {
    const { db, alice, posts } = setup();
    const r = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '出闲置',
      bodyMd: '有意加微信详聊',
    });
    expect(r.pendingReview).toBe(true);

    const list = await posts.listPosts(caller(db, alice), 'general');
    expect(list.items).toHaveLength(0);

    // 但记录在库里，等人工处理
    const row = db.prepare('SELECT review_state FROM forum_posts WHERE id = ?').get(r.postId) as {
      review_state: string;
    };
    expect(row.review_state).toBe('pending_review');
  });

  it('放行与挡下都写审核记录', async () => {
    const { db, alice, posts } = setup();
    await posts.createPost(caller(db, alice), { boardSlug: 'general', title: '正常', bodyMd: '正常内容' });
    await posts.createPost(caller(db, alice), { boardSlug: 'general', title: '广告', bodyMd: '加微信' });

    const rows = db
      .prepare('SELECT verdict, rule FROM forum_post_screenings ORDER BY created_at, id')
      .all() as Array<{ verdict: string; rule: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.verdict === 'passed')).toHaveLength(1);
    expect(rows.filter((r) => r.verdict === 'blocked')).toHaveLength(1);
  });

  it('站点设置里的违禁词表覆盖内置表', async () => {
    const { db, alice, posts } = setup();
    // 走真实的设置服务写入：顺便验证"管理员改词表不用发版"这条路径确实通
    const adminId = insertUser(db, { role: 'admin' });
    const adminCtx: CallerContext = { userId: adminId, role: 'admin', accountStatus: 'active' };
    await createSettingsService({ db }).update(adminCtx, {
      changes: { 'forum.banned_words': '自定义禁用词' },
      reason: '测试用：换一套违禁词',
      requestKey: 'test-banned-words',
    });

    const hit = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '标题',
      bodyMd: '这里有自定义禁用词',
    });
    expect(hit.pendingReview).toBe(true);

    // 内置词表被覆盖，原有的"加微信"不再命中
    const notHit = await posts.createPost(caller(db, alice), {
      boardSlug: 'general',
      title: '标题二',
      bodyMd: '加微信',
    });
    expect(notHit.pendingReview).toBe(false);
  });
});
