/**
 * 讨论区 · 发帖草稿（迁移 0038）。
 *
 * 重点测：
 *   1. 草稿允许标题或正文为空（写一半关掉页面是正常操作）；
 *   2. 草稿只有作者本人可见，别人的草稿与不存在给同一个答案；
 *   3. 保存是覆盖式：再次保存替换全文与附件列表；
 *   4. 发布走与直接发帖同一套服务（权限 / 自动审核 / 附件），成功后草稿消失；
 *   5. 发布失败时草稿原样留着，用户不必重打。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { createForumDraftService } from '../src/server/modules/forum/drafts';
import type { CallerContext } from '@/server/platform/context';
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

const isInputInvalid = (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID;

function setup() {
  ctx = createTestDb();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const alice = insertUser(db);
  const bob = insertUser(db);
  ensureDefaultBoards(db);
  const general = db.prepare("SELECT id FROM forum_boards WHERE slug = 'general'").get() as { id: string };
  return {
    db,
    admin,
    alice,
    bob,
    generalId: general.id,
    drafts: createForumDraftService({ db }),
    posts: createForumPostService({ db }),
    boards: createForumBoardService({ db }),
  };
}

describe('保存草稿', () => {
  it('新建草稿：只选分区也能存，标题正文都为空', async () => {
    const { db, alice, generalId, drafts } = setup();
    const saved = await drafts.saveDraft(caller(db, alice), { boardId: generalId });
    expect(saved.created).toBe(true);
    const list = await drafts.listMine(caller(db, alice));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].title).toBe('');
    expect(list.items[0].bodyMd).toBe('');
    expect(list.items[0].boardSlug).toBe('general');
  });

  it('再次保存是覆盖：全文与附件列表都替换', async () => {
    const { db, alice, generalId, drafts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '初稿',
      bodyMd: '第一版',
    });
    const again = await drafts.saveDraft(caller(db, alice), {
      draftId,
      title: '改过的标题',
      bodyMd: '第二版',
    });
    expect(again.created).toBe(false);
    const one = await drafts.getDraft(caller(db, alice), draftId);
    expect(one.title).toBe('改过的标题');
    expect(one.bodyMd).toBe('第二版');
    expect(one.fileIds).toEqual([]);
  });

  it('新建时不带分区被拒', async () => {
    const { db, alice, drafts } = setup();
    await expect(drafts.saveDraft(caller(db, alice), { title: '无分区' })).rejects.toSatisfy(isInputInvalid);
  });

  it('超长正文被拒（与帖子同一个上限）', async () => {
    const { db, alice, generalId, drafts } = setup();
    await expect(
      drafts.saveDraft(caller(db, alice), { boardId: generalId, bodyMd: 'x'.repeat(20001) }),
    ).rejects.toSatisfy(isInputInvalid);
  });
});

describe('草稿归属', () => {
  it('别人的草稿读不到，报错与"不存在"一致', async () => {
    const { db, alice, bob, generalId, drafts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), { boardId: generalId, title: '我的草稿' });
    await expect(drafts.getDraft(caller(db, bob), draftId)).rejects.toSatisfy(isInputInvalid);
    await expect(drafts.getDraft(caller(db, bob), 'draft-does-not-exist')).rejects.toSatisfy(isInputInvalid);
  });

  it('列表只列自己的', async () => {
    const { db, alice, bob, generalId, drafts } = setup();
    await drafts.saveDraft(caller(db, alice), { boardId: generalId, title: 'A 的' });
    await drafts.saveDraft(caller(db, bob), { boardId: generalId, title: 'B 的' });
    expect((await drafts.listMine(caller(db, alice))).items).toHaveLength(1);
    expect((await drafts.listMine(caller(db, alice))).items[0].title).toBe('A 的');
  });

  it('别人不能改、不能删我的草稿', async () => {
    const { db, alice, bob, generalId, drafts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), { boardId: generalId, title: '我的' });
    await expect(drafts.saveDraft(caller(db, bob), { draftId, title: '篡改' })).rejects.toSatisfy(isInputInvalid);
    await expect(drafts.deleteDraft(caller(db, bob), draftId)).rejects.toSatisfy(isInputInvalid);
    expect((await drafts.getDraft(caller(db, alice), draftId)).title).toBe('我的');
  });

  it('匿名不能读写草稿', async () => {
    const { generalId, drafts } = setup();
    const anon: CallerContext = { userId: null, role: 'user', accountStatus: 'active' };
    await expect(drafts.saveDraft(anon, { boardId: generalId })).rejects.toSatisfy((e: unknown) =>
      isDomainError(e) && e.code === ErrorCodes.UNAUTHENTICATED,
    );
    await expect(drafts.listMine(anon)).rejects.toSatisfy((e: unknown) =>
      isDomainError(e) && e.code === ErrorCodes.UNAUTHENTICATED,
    );
  });
});

describe('从草稿发布', () => {
  it('发布成帖子后草稿消失，帖子出现在分区列表', async () => {
    const { db, alice, generalId, drafts, posts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '草稿发出来的帖子',
      bodyMd: '正文内容',
    });
    const draft = await drafts.getDraft(caller(db, alice), draftId);
    const { postId, pendingReview } = await posts.createPost(caller(db, alice), {
      boardSlug: draft.boardSlug,
      title: draft.title,
      bodyMd: draft.bodyMd,
      fileIds: draft.fileIds,
    });
    await drafts.deleteDraft(caller(db, alice), draftId);

    expect(pendingReview).toBe(false);
    const page = await posts.listPosts(caller(db, alice), 'general');
    expect(page.items.map((p) => p.postId)).toContain(postId);
    expect((await drafts.listMine(caller(db, alice))).items).toHaveLength(0);
  });

  it('草稿为空时发布被发帖服务拦下，草稿还在', async () => {
    const { db, alice, generalId, drafts, posts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), { boardId: generalId });
    const draft = await drafts.getDraft(caller(db, alice), draftId);
    await expect(
      posts.createPost(caller(db, alice), {
        boardSlug: draft.boardSlug,
        title: draft.title,
        bodyMd: draft.bodyMd,
        fileIds: draft.fileIds,
      }),
    ).rejects.toSatisfy(isInputInvalid);
    // 发布失败不该把草稿吃掉
    expect((await drafts.listMine(caller(db, alice))).items).toHaveLength(1);
  });

  it('草稿发布时同样过自动审核：命中违禁词进待审', async () => {
    const { db, alice, generalId, drafts, posts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '一个普通标题',
      bodyMd: '这里有代开发票的广告',
    });
    const draft = await drafts.getDraft(caller(db, alice), draftId);
    const result = await posts.createPost(caller(db, alice), {
      boardSlug: draft.boardSlug,
      title: draft.title,
      bodyMd: draft.bodyMd,
    });
    expect(result.pendingReview).toBe(true);
    const page = await posts.listPosts(caller(db, alice), 'general');
    expect(page.items).toHaveLength(0);
  });

  it('草稿所在分区归档后发不出去', async () => {
    const { db, admin, alice, generalId, drafts, posts, boards } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), {
      boardId: generalId,
      title: '归档前写的',
      bodyMd: '正文',
    });
    await boards.setBoardStatus(caller(db, admin), generalId, 'archived');
    const draft = await drafts.getDraft(caller(db, alice), draftId);
    await expect(
      posts.createPost(caller(db, alice), {
        boardSlug: draft.boardSlug,
        title: draft.title,
        bodyMd: draft.bodyMd,
      }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
    expect((await drafts.listMine(caller(db, alice))).items).toHaveLength(1);
  });

  it('删除草稿后读不到', async () => {
    const { db, alice, generalId, drafts } = setup();
    const { draftId } = await drafts.saveDraft(caller(db, alice), { boardId: generalId, title: '要删的' });
    await drafts.deleteDraft(caller(db, alice), draftId);
    await expect(drafts.getDraft(caller(db, alice), draftId)).rejects.toSatisfy(isInputInvalid);
  });
});
