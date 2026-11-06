/**
 * 讨论区 · 附件链路（S1 客户端附件契约 + S2 论坛图片对非上传者可读）。
 *
 * 为什么单独一个文件：审查指出 85 项服务层测试全绿却漏掉了这两条，
 * 因为它们盯的是**跨越客户端与服务端的契约**，而既有论坛测试是手工塞
 * attachment_files.id 进去的，等于自己绕过了前端真正会传的东西。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createForumPostService } from '../src/server/modules/forum/posts';
import { createMediaService } from '../src/server/modules/media/service';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';
import { createHash } from 'node:crypto';
import type { FileStore } from '../src/server/platform/file-store';

let ctx: TestDb | null = null;
/** 每个用例重建的内存文件存储；makeReadyUpload 会往里放字节。 */
let store: ReturnType<typeof memoryStore>;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string | null): CallerContext {
  if (userId === null) return { userId: null, role: 'user', accountStatus: 'active' };
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

function setup() {
  ctx = createTestDb();
  store = memoryStore();
  const db = ctx.db;
  const admin = insertUser(db, { role: 'admin' });
  const alice = insertUser(db);
  const bob = insertUser(db);
  ensureDefaultBoards(db);
  return {
    db,
    admin,
    alice,
    bob,
    posts: createForumPostService({ db }),
    // 媒体服务默认用本地磁盘 store，测试里文件并不真的存在，会让「可读」用例
    // 在最后一步取字节时拿到 null——那不是权限判断失败，是夹具缺文件。
    // 注入一个内存 store，把「判权」与「取字节」两件事分开。
    media: createMediaService({ db, store }),
  };
}

const basePost = { boardSlug: 'general', title: '带图的帖子', bodyMd: '见下图。' };

/**
 * 极简内存文件存储：key → 字节。
 *
 * 必须实现完整的 FileStore 接口（put/get/exists/remove/resolvePath），
 * 且 put 要返回 StoredObject——只实现 get 会在类型检查时被挡下。
 * 用它把「判权」与「取字节」两件事分开：测试里没有真实磁盘文件。
 */
function memoryStore(): FileStore {
  const blobs = new Map<string, Buffer>();
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  return {
    put: (storageKey: string, bytes: Buffer) => {
      blobs.set(storageKey, bytes);
      return Promise.resolve({ storageKey, byteSize: bytes.length, sha256: sha(bytes) });
    },
    get: (storageKey: string) => Promise.resolve(blobs.get(storageKey) ?? null),
    exists: (storageKey: string) => Promise.resolve(blobs.has(storageKey)),
    remove: (storageKey: string) => {
      blobs.delete(storageKey);
      return Promise.resolve();
    },
    resolvePath: (storageKey: string) => storageKey,
  };
}

/** 造一份「已就绪」的上传：同时有 original 与 display 两个文件变体。 */
function makeReadyUpload(db: TestDb['db'], owner: string, tag: string) {
  const attachmentId = 'att_' + tag;
  const originalFileId = 'file_orig_' + tag;
  const displayFileId = 'file_disp_' + tag;
  const now = Date.now();
  db.prepare(
    'INSERT INTO attachments (id, uploaded_by, original_filename, processing_state, created_at, ready_at) VALUES (?,?,?,?,?,?)',
  ).run(attachmentId, owner, 'a.png', 'ready', now, now);
  const insertFile = db.prepare(
    'INSERT INTO attachment_files (id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height, content_hash, processing_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const hash = (t: string) =>
    Array.from(t)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
      .padEnd(64, '0')
      .slice(0, 64);
  insertFile.run(originalFileId, attachmentId, 'orig', 'original', 'image/png', 100, 10, 10, hash('o' + tag), 'ready', now);
  insertFile.run(displayFileId, attachmentId, 'disp', 'display', 'image/png', 80, 10, 10, hash('d' + tag), 'ready', now);
  // resolveReadable 的查询 JOIN 了 attachment_blobs，没有 blob 行会直接返回 null，
  // 那样「可读」用例永远失败、「不可读」用例假绿——这里必须一并造出来。
  const insertBlob = db.prepare(
    'INSERT INTO attachment_blobs (id, file_id, storage_key, byte_size, content_hash, verified_at, created_at) VALUES (?,?,?,?,?,?,?)',
  );
  insertBlob.run('blob_o_' + tag, originalFileId, 'store/orig_' + tag, 100, hash('o' + tag), now, now);
  insertBlob.run('blob_d_' + tag, displayFileId, 'store/disp_' + tag, 80, hash('d' + tag), now, now);
  // 字节也要真的放进 store：resolveReadable 判权通过后会再去取字节，
  // 取不到仍返回 null，那样「可读」用例会假失败。
  store.put('store/orig_' + tag, Buffer.from('orig-bytes-' + tag));
  store.put('store/disp_' + tag, Buffer.from('disp-bytes-' + tag));
  return { attachmentId, originalFileId, displayFileId };
}

describe('S1 附件 id 契约', () => {
  it('传 displayFileId 能建成帖，引用表里落的就是它', async () => {
    const { db, alice, posts } = setup();
    const { displayFileId } = makeReadyUpload(db, alice, 'a1');
    const { postId } = await posts.createPost(caller(db, alice), { ...basePost, fileIds: [displayFileId] });
    const links = db
      .prepare('SELECT file_id FROM forum_post_attachment_links WHERE post_id = ?')
      .all(postId) as Array<{ file_id: string }>;
    expect(links.map((l) => l.file_id)).toEqual([displayFileId]);
  });

  it('传 attachmentId 也能建成帖——服务端解析成 display 文件（这就是 S1 的根因）', async () => {
    const { db, alice, posts } = setup();
    const { attachmentId, displayFileId } = makeReadyUpload(db, alice, 'a2');
    const { postId } = await posts.createPost(caller(db, alice), { ...basePost, fileIds: [attachmentId] });
    const links = db
      .prepare('SELECT file_id FROM forum_post_attachment_links WHERE post_id = ?')
      .all(postId) as Array<{ file_id: string }>;
    expect(links.map((l) => l.file_id)).toEqual([displayFileId]);
  });

  it('直接引用原图会被拒（正文只能用展示图）', async () => {
    const { db, alice, posts } = setup();
    const { originalFileId } = makeReadyUpload(db, alice, 'a3');
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, fileIds: [originalFileId] }),
    ).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID && /原图不能直接引用/.test(e.message),
    );
  });

  it('附件未就绪时给「稍后再试」，不误报成不是你的图', async () => {
    const { db, alice, posts } = setup();
    const { attachmentId } = makeReadyUpload(db, alice, 'a4');
    // 表上有 CHECK ((processing_state = 'ready') = (ready_at IS NOT NULL))，改状态要连 ready_at 一起清
    db.prepare("UPDATE attachments SET processing_state = 'processing', ready_at = NULL WHERE id = ?").run(attachmentId);
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, fileIds: [attachmentId] }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID && /还没处理好/.test(e.message));
  });

  it('挂别人的附件是 forbidden', async () => {
    const { db, alice, bob, posts } = setup();
    const { displayFileId } = makeReadyUpload(db, bob, 'b1');
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, fileIds: [displayFileId] }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.FORBIDDEN);
  });

  it('不存在的附件 id 报 input_invalid', async () => {
    const { db, alice, posts } = setup();
    await expect(
      posts.createPost(caller(db, alice), { ...basePost, fileIds: ['file_does_not_exist'] }),
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.code === ErrorCodes.INPUT_INVALID);
  });
});

describe('S2 论坛图片的公开可读性', () => {
  it('已发布帖子里的图，匿名访客也能拿到 display 变体', async () => {
    const { db, alice, posts, media } = setup();
    const { displayFileId, attachmentId } = makeReadyUpload(db, alice, 'p1');
    await posts.createPost(caller(db, alice), { ...basePost, fileIds: [displayFileId] });
    const got = await media.resolveReadable({ attachmentId, variantKey: 'disp' }, caller(db, null));
    expect(got).not.toBeNull();
  });

  it('帖子被软删后，匿名访客读不到图了', async () => {
    const { db, alice, posts, media } = setup();
    const { displayFileId, attachmentId } = makeReadyUpload(db, alice, 'p2');
    const { postId } = await posts.createPost(caller(db, alice), { ...basePost, fileIds: [displayFileId] });
    await posts.deletePost(caller(db, alice), postId);
    const got = await media.resolveReadable({ attachmentId, variantKey: 'disp' }, caller(db, null));
    expect(got).toBeNull();
  });

  it('只上传没被任何帖子引用的图，别人读不到', async () => {
    const { db, alice, media } = setup();
    const { attachmentId } = makeReadyUpload(db, alice, 'p3');
    const got = await media.resolveReadable({ attachmentId, variantKey: 'disp' }, caller(db, null));
    expect(got).toBeNull();
  });

  it('原图变体不对外公开，即便在同一张已发布帖子里', async () => {
    const { db, alice, posts, media } = setup();
    const { displayFileId, attachmentId } = makeReadyUpload(db, alice, 'p4');
    await posts.createPost(caller(db, alice), { ...basePost, fileIds: [displayFileId] });
    const got = await media.resolveReadable({ attachmentId, variantKey: 'orig' }, caller(db, null));
    expect(got).toBeNull();
  });
});
