/**
 * 讨论区 · 可见性与总开关（S5 / S6 / S7 / M2 / S8）。
 *
 * 这五条的共同点是「看起来做了、实际没生效」：软删只改了 status、开关只关了页面、
 * 编辑绕过了审核。所以这里钉的是**外部可观察的行为**，不是内部实现：
 *
 *   S5 已删除 / 待审帖：正文只对作者与管理者可见，其余人拿到的 bodyMd 是 null；
 *   S6 已删除回复：匿名列表接口拿不到 body_md，但占位（作者/时间/层级）还在；
 *   S7 讨论区总开关：关掉后 /api/forum/** 与 /api/admin/forum/** 一律 404；
 *   M2 回复与发帖同一套分区权限：被拉黑、白名单、仅管理员分区都拦得住回复；
 *   S8 编辑重跑自动审核：改成违禁内容回到待审，改干净了回到已发布，且都留审核记录。
 *
 * 测试用真实临时库 + 真实迁移（tests/support/db.ts 的 createTestDb），不用 :memory: 冒充。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话 Cookie 的可变桩：读取时按当前值返回。 */
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (auth.token === null ? undefined : { name, value: auth.token }),
  }),
}));

import { GET as getPostRoute } from '../src/app/api/forum/posts/[postId]/route';
import { GET as getRepliesRoute } from '../src/app/api/forum/posts/[postId]/replies/route';
import { GET as getBoardsRoute } from '../src/app/api/forum/boards/route';
import { GET as getAdminQueueRoute } from '../src/app/api/admin/forum/applications/route';
import { closeDb, type SqliteDatabase } from '../src/server/platform/db';
import { createIdentityService } from '../src/server/modules/identity';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { createSettingsService } from '../src/server/modules/settings';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';
import { createTestDb, insertUser, type TestDb } from './support/db';

let h: TestDb;
let db: SqliteDatabase;

const anonymous: CallerContext = { userId: null, role: null, accountStatus: null };

beforeEach(() => {
  h = createTestDb();
  db = h.db;
  process.env.DSH_REVIEW_DB_PATH = h.file;
  closeDb();
  auth.token = null;
});

afterEach(() => {
  closeDb();
  h.cleanup();
  delete process.env.DSH_REVIEW_DB_PATH;
  auth.token = null;
});

function caller(userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

/** 造出「管理员 + 作者 + 一个路人 + 一个本区协管」的最小现场。 */
async function setup() {
  const admin = insertUser(db, { role: 'admin', nickname: '站方' });
  const alice = insertUser(db, { nickname: '作者' });
  const bob = insertUser(db, { nickname: '路人' });
  const mod = insertUser(db, { nickname: '协管' });
  ensureDefaultBoards(db);
  const boards = createForumBoardService({ db });
  const posts = createForumPostService({ db });
  const board = db.prepare("SELECT id FROM forum_boards WHERE slug = 'general'").get() as { id: string };
  await boards.appointModerator(caller(admin), board.id, mod);
  return { admin, alice, bob, mod, board, boards, posts };
}

async function signIn(userId: string): Promise<void> {
  const identity = createIdentityService({ db });
  const session = await identity.createSession(userId, Date.now());
  auth.token = session.token;
}

interface OkBody<T> {
  ok: true;
  data: T;
}
interface FailBody {
  ok: false;
  error: { code: string; message: string };
}

function routeFor(postId: string): { params: Promise<{ postId: string }> } {
  return { params: Promise.resolve({ postId }) };
}
// ============================================================
// S5 已删除 / 待审帖的正文
// ============================================================

describe('S5 帖子详情：已删除与待审的正文只给该看的人', () => {
  it('已删除的帖子：匿名与路人拿不到正文，作者/协管/站方拿得到，且状态字段照常给出', async () => {
    const { admin, alice, bob, mod, posts } = await setup();
    const { postId } = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '敏感标题',
      bodyMd: '这是一段不该外泄的正文。',
    });
    await posts.deletePost(caller(alice), postId);

    const asAnon = await posts.getPost(anonymous, postId);
    expect(asAnon.bodyMd).toBeNull();
    // 标题同样是内容：正文藏了标题漏了等于没藏
    expect(asAnon.title).not.toContain('敏感');
    // 状态与痕迹要留着，否则页面没法解释「这篇去哪了」
    expect(asAnon.status).toBe('deleted');
    expect(asAnon.reviewState).toBe('published');

    const asStranger = await posts.getPost(caller(bob), postId);
    expect(asStranger.bodyMd).toBeNull();

    for (const viewer of [alice, mod, admin]) {
      const view = await posts.getPost(caller(viewer), postId);
      expect(view.bodyMd).toBe('这是一段不该外泄的正文。');
      expect(view.title).toBe('敏感标题');
    }
  });

  it('待审的帖子：匿名/路人/本区协管都看不到，只有作者与站方管理员看得到', async () => {
    const { alice, bob, mod, posts } = await setup();
    // 命中违禁词 -> pending_review
    const created = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '代开发票',
      bodyMd: '正文里写了违禁内容。',
    });
    expect(created.pendingReview).toBe(true);

    const asAnon = await posts.getPost(anonymous, created.postId);
    expect(asAnon.bodyMd).toBeNull();
    expect(asAnon.reviewState).toBe('pending_review');

    expect((await posts.getPost(caller(bob), created.postId)).bodyMd).toBeNull();
    // 本区协管也看不到：待审是站方口径，分区的人不该提前看到未放行的内容
    expect((await posts.getPost(caller(mod), created.postId)).bodyMd).toBeNull();

    expect((await posts.getPost(caller(alice), created.postId)).bodyMd).toBe('正文里写了违禁内容。');
  });

  it('GET /api/forum/posts/{id} 匿名请求同样拿不到已删帖正文（接口层不另开口子）', async () => {
    const { alice, posts } = await setup();
    const { postId } = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '要删掉的帖子',
      bodyMd: '正文内容坐标 42。',
    });
    await posts.deletePost(caller(alice), postId);

    const res = await getPostRoute(new Request('http://localhost/api/forum/posts/' + postId), routeFor(postId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody<{ bodyMd: string | null; status: string }>;
    expect(body.data.bodyMd).toBeNull();
    expect(body.data.status).toBe('deleted');
    expect(JSON.stringify(body)).not.toContain('坐标 42');
  });
});
// ============================================================
// S6 已删除回复
// ============================================================

describe('S6 回复列表：已删除的回复对无权者脱敏，占位保留', () => {
  async function seedPostWithReply() {
    const s = await setup();
    const { postId } = await s.posts.createPost(caller(s.alice), {
      boardSlug: 'general',
      title: '一篇正常的帖子',
      bodyMd: '欢迎大家讨论。',
    });
    const { replyId } = await s.posts.createReply(caller(s.alice), postId, { bodyMd: '这是一条后来被删的回复。' });
    await s.posts.deleteReply(caller(s.alice), replyId);
    return { ...s, postId, replyId };
  }

  it('匿名列表里 bodyMd 为 null，但作者与创建时间还在（否则子回复失去上下文）', async () => {
    const { postId, replyId } = await seedPostWithReply();
    const posts = createForumPostService({ db });
    const list = await posts.listReplies(anonymous, postId);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].replyId).toBe(replyId);
    expect(list.items[0].bodyMd).toBeNull();
    expect(list.items[0].status).toBe('deleted');
    expect(list.items[0].authorNickname).toBe('作者');
    expect(list.items[0].createdAt).toBeGreaterThan(0);
  });

  it('作者与管理者仍能看到原文，路人不行', async () => {
    const { alice, admin, bob, postId } = await seedPostWithReply();
    const posts = createForumPostService({ db });
    expect((await posts.listReplies(caller(alice), postId)).items[0].bodyMd).toBe('这是一条后来被删的回复。');
    expect((await posts.listReplies(caller(admin), postId)).items[0].bodyMd).toBe('这是一条后来被删的回复。');
    expect((await posts.listReplies(caller(bob), postId)).items[0].bodyMd).toBeNull();
  });

  it('GET /api/forum/posts/{id}/replies 匿名批量拉取拿不到已删正文', async () => {
    const { postId } = await seedPostWithReply();
    const res = await getRepliesRoute(
      new Request('http://localhost/api/forum/posts/' + postId + '/replies'),
      routeFor(postId),
    );
    expect(res.status).toBe(200);
    const text = JSON.stringify((await res.json()) as OkBody<unknown>);
    expect(text).not.toContain('后来被删的回复');
  });
});
// ============================================================
// S7 讨论区总开关
// ============================================================

async function disableForum(adminId: string): Promise<unknown> {
  // 走真正的配置服务，而不是手写 INSERT：site_settings.changed_in_revision_id 非空，
  // 手写插入会撞约束，也测不出「改配置这件事本身」。
  const settings = createSettingsService({ db });
  return settings.update(
    { userId: adminId, role: 'admin', accountStatus: 'active' },
    { changes: { 'forum.enabled': false }, reason: '测试：关站', requestKey: 'test-disable-' + Math.random() },
  );
}

describe('S7 forum.enabled=false 时接口一律 404', () => {
  it('开关关闭：分区列表、帖子详情、回复列表、后台队列全部 404（不是 403）', async () => {
    const { admin, alice, posts } = await setup();
    const { postId } = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '关站前的帖子',
      bodyMd: '关站后不该还能通过接口读到。',
    });
    await disableForum(admin);

    const boards = await getBoardsRoute(new Request('http://localhost/api/forum/boards'));
    expect(boards.status).toBe(404);

    const detail = await getPostRoute(new Request('http://localhost/api/forum/posts/' + postId), routeFor(postId));
    expect(detail.status).toBe(404);
    const detailBody = (await detail.json()) as FailBody;
    expect(detailBody.error.code).toBe(ErrorCodes.TARGET_UNAVAILABLE);

    const replies = await getRepliesRoute(
      new Request('http://localhost/api/forum/posts/' + postId + '/replies'),
      routeFor(postId),
    );
    expect(replies.status).toBe(404);

    // 后台接口同一口径：关站后连管理员也拿不到讨论区数据入口
    await signIn(admin);
    const adminQueue = await getAdminQueueRoute(new Request('http://localhost/api/admin/forum/applications'));
    expect(adminQueue.status).toBe(404);
  });

  it('开关判断先于鉴权：匿名访问也是 404 而不是 401', async () => {
    const { admin } = await setup();
    await disableForum(admin);
    // 若先判鉴权会给 401，等于告诉外面「这里有个接口」
    const res = await getBoardsRoute(new Request('http://localhost/api/forum/boards'));
    expect(res.status).toBe(404);
  });

  it('开关默认开启：没有该配置行时接口照常工作', async () => {
    const { alice, posts } = await setup();
    await posts.createPost(caller(alice), { boardSlug: 'general', title: '正常帖子', bodyMd: '正常正文。' });
    const res = await getBoardsRoute(new Request('http://localhost/api/forum/boards'));
    expect(res.status).toBe(200);
  });
});
// ============================================================
// M2 回复与发帖同一套分区权限
// ============================================================

describe('M2 createReply 与发帖同一套分区权限', () => {
  it('被拉黑（deny）的用户不能回复', async () => {
    const { admin, alice, bob, board, boards, posts } = await setup();
    const { postId } = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '正常帖子',
      bodyMd: '正文。',
    });
    await boards.setPostingRule(caller(admin), board.id, bob, 'deny');

    await expect(
      posts.createReply(caller(bob), postId, { bodyMd: '我被拉黑了还想回复。' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
  });

  it('仅管理员可发的分区：普通用户回复被拒，管理员可以', async () => {
    const { admin, alice, posts } = await setup();
    const { postId } = await posts.createPost(caller(admin), {
      boardSlug: 'announcements',
      title: '官方公告',
      bodyMd: '公告正文。',
    });
    await expect(
      posts.createReply(caller(alice), postId, { bodyMd: '普通用户来回复公告区。' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);

    await expect(posts.createReply(caller(admin), postId, { bodyMd: '管理员回复自己的公告。' })).resolves.toBeTruthy();
  });

  it('归档分区不能回复（与不能发帖一致）', async () => {
    const { admin, alice, board, boards, posts } = await setup();
    const { postId } = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '归档前的帖子',
      bodyMd: '正文。',
    });
    await boards.setBoardStatus(caller(admin), board.id, 'archived');
    await expect(
      posts.createReply(caller(alice), postId, { bodyMd: '归档后还想回复。' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
  });

  it('白名单分区：不在名单里的人不能回复，在名单里的可以', async () => {
    const { admin, alice, bob, board, boards, posts } = await setup();
    const { postId } = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '白名单时代的帖子',
      bodyMd: '正文。',
    });
    await boards.setPostingPolicy(caller(admin), board.id, 'whitelist');

    await expect(
      posts.createReply(caller(bob), postId, { bodyMd: '我不在白名单里。' }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);

    await boards.setPostingRule(caller(admin), board.id, bob, 'allow');
    await expect(posts.createReply(caller(bob), postId, { bodyMd: '放进白名单后可以回复。' })).resolves.toBeTruthy();
  });
});
// ============================================================
// S8 编辑重跑自动审核
// ============================================================

describe('S8 编辑帖子要重跑自动审核', () => {
  it('先发干净帖、再改成违禁内容：回到待审并写一条审核记录', async () => {
    const { alice, posts } = await setup();
    const created = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '干净标题',
      bodyMd: '干净的正文。',
    });
    expect(created.pendingReview).toBe(false);

    await posts.editPost(caller(alice), created.postId, {
      title: '干净标题',
      bodyMd: '加个微信聊聊，还有代开发票。',
    });

    const view = await posts.getPost(caller(alice), created.postId);
    expect(view.reviewState).toBe('pending_review');

    // 不进公开列表
    const page = await posts.listPosts(anonymous, 'general');
    expect(page.items.some((p) => p.postId === created.postId)).toBe(false);

    const screenings = db
      .prepare('SELECT verdict FROM forum_post_screenings WHERE post_id = ? ORDER BY created_at, rowid')
      .all(created.postId) as Array<{ verdict: string }>;
    expect(screenings.map((s) => s.verdict)).toEqual(['passed', 'blocked']);
  });

  it('待审帖改成干净内容：自动放行并回到已发布，同样留记录', async () => {
    const { alice, posts } = await setup();
    const created = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '刷单兼职',
      bodyMd: '正文里有违禁词。',
    });
    expect(created.pendingReview).toBe(true);

    await posts.editPost(caller(alice), created.postId, {
      title: '改好之后的标题',
      bodyMd: '这是一段干净、正常的正文。',
    });

    const view = await posts.getPost(caller(alice), created.postId);
    expect(view.reviewState).toBe('published');
    const page = await posts.listPosts(anonymous, 'general');
    expect(page.items.some((p) => p.postId === created.postId)).toBe(true);

    const screenings = db
      .prepare('SELECT verdict FROM forum_post_screenings WHERE post_id = ? ORDER BY created_at, rowid')
      .all(created.postId) as Array<{ verdict: string }>;
    expect(screenings.map((s) => s.verdict)).toEqual(['blocked', 'passed']);
  });

  it('编辑不能绕过外链刷屏规则', async () => {
    const { alice, posts } = await setup();
    const created = await posts.createPost(caller(alice), {
      boardSlug: 'general',
      title: '正常帖子',
      bodyMd: '正文。',
    });
    const spam = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'].join(' ');
    await posts.editPost(caller(alice), created.postId, { title: '正常标题', bodyMd: spam });
    expect((await posts.getPost(caller(alice), created.postId)).reviewState).toBe('pending_review');
  });
});
