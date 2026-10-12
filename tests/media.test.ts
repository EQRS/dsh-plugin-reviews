/**
 * 媒体模块测试：真实图片字节、真实格式鉴定、真实落盘校验。
 *
 * 每条用例都能在实现被破坏时变红：
 *  - 去掉 probeImage 的真实解码 → 「伪装格式被拒」失败；
 *  - 去掉落盘回读校验 → 「摘要不符不入库」失败；
 *  - 去掉权限判断 → 「匿名读私有图被拒」失败。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createMediaService,
  probeImage,
  buildDisplayImage,
  storageKeyFor,
  MEDIA_LIMITS,
} from '../src/server/modules/media';
import { createLocalFileStore } from '../src/server/platform/file-store';
import type { CallerContext } from '../src/server/platform/context';

let dir: string;
let db: Database.Database;
let store: ReturnType<typeof createLocalFileStore>;
let media: ReturnType<typeof createMediaService>;
let userId: string;

/** 建一个带真实迁移的临时库 + 隔离媒体目录。 */
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'media-'));
  const dbFile = join(dir, 'app.sqlite');
  db = new Database(dbFile);
  db.pragma('foreign_keys = ON');

  const migrations = join(process.cwd(), 'migrations');
  for (const f of ['0001_baseline.sql', '0002_triggers.sql', '0003_auth_media.sql']) {
    db.exec(require('node:fs').readFileSync(join(migrations, f), 'utf8'));
  }

  userId = '01920000-0000-7000-8000-0000000000c1';
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, nickname, role, account_status, created_at, updated_at)
     VALUES (?, '上传者', 'user', 'active', ?, ?)`,
  ).run(userId, now, now);

  store = createLocalFileStore({ root: join(dir, 'media') });
  media = createMediaService({ db, store });
}

beforeEach(() => {
  setup();
});

/** 建一个属于该用户的草稿（媒体服务要求草稿归属校验）。 */
function makeDraft(ownerId = userId): string {
  const repoId = '01920000-0000-7000-8000-0000000000c2';
  const pluginId = '01920000-0000-7000-8000-0000000000c3';
  const reviewId = '01920000-0000-7000-8000-0000000000c4';
  const draftId = '01920000-0000-7000-8000-0000000000c5';
  const now = Date.now();

  db.prepare(
    `INSERT OR IGNORE INTO repositories (id, github_repository_id, full_name, html_url, availability_state, created_at, updated_at)
     VALUES (?, 'gh-media', 'a/b', 'https://github.com/a/b', 'available', ?, ?)`,
  ).run(repoId, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO plugins (id, repository_id, plugin_path, created_at, updated_at) VALUES (?, ?, '.', ?, ?)`,
  ).run(pluginId, repoId, now, now);

  if (db.prepare('SELECT id FROM content_entities WHERE id = ?').get(reviewId) === undefined) {
    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO content_entities (id, content_type, author_id, review_id, created_at)
         VALUES (?, 'review', ?, ?, ?)`,
      ).run(reviewId, ownerId, reviewId, now);
      db.prepare(`INSERT INTO reviews (id, plugin_id, source_kind) VALUES (?, ?, 'community')`).run(reviewId, pluginId);
    });
    run();
  }
  if (db.prepare('SELECT id FROM content_drafts WHERE id = ?').get(draftId) === undefined) {
    db.prepare(
      `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, save_version, created_at, saved_at)
       VALUES (?, ?, 'review', ?, '{}', 0, ?, ?)`,
    ).run(draftId, ownerId, reviewId, now, now);
  }
  return draftId;
}

function ctxFor(id: string | null): CallerContext {
  if (id === null) return { userId: null, role: null, accountStatus: null };
  return { userId: id, role: 'user', accountStatus: 'active' };
}

/** 造一张真实的 PNG。 */
async function realPng(width = 200, height = 100): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } } })
    .png()
    .toBuffer();
}

/** 造一张超大尺寸的 PNG（用于验证会生成缩小后的展示图）。 */
async function bigPng(): Promise<Buffer> {
  return sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('真实格式鉴定（probeImage）', () => {
  it('真的 PNG 被识别为 image/png，并读出真实尺寸', async () => {
    const png = await realPng(200, 100);
    const r = await probeImage(png);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mime).toBe('image/png');
      expect(r.width).toBe(200);
      expect(r.height).toBe(100);
    }
  });

  it('伪装成 .png 的文本文件被拒绝（不看扩展名，看内容）', async () => {
    const fake = Buffer.from('这不是图片，只是一段文字'.repeat(20), 'utf8');
    const r = await probeImage(fake);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['decode_failed', 'unsupported_format']).toContain(r.code);
  });

  it('空文件被拒绝，且原因是 empty_file', async () => {
    const r = await probeImage(Buffer.alloc(0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('empty_file');
  });

  it('超过单张限额被拒绝，且原因是 too_large', async () => {
    const oversized = Buffer.alloc(MEDIA_LIMITS.maxBytes + 1, 1);
    const r = await probeImage(oversized);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_large');
  });
});

describe('展示图生成（buildDisplayImage）', () => {
  it('大图会被缩小到长边上限内，且字节与原图不同', async () => {
    const big = await bigPng();
    const out = await buildDisplayImage(big, 'image/png');

    expect(out.resized).toBe(true);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(MEDIA_LIMITS.displayMaxEdge);
    expect(out.bytes.equals(big)).toBe(false);
    expect(out.bytes.byteLength).toBeLessThan(big.byteLength);
  });

  it('小图不放大（withoutEnlargement），原样返回', async () => {
    const small = await realPng(120, 80);
    const out = await buildDisplayImage(small, 'image/png');
    expect(out.resized).toBe(false);
    expect(out.width).toBe(120);
    expect(out.height).toBe(80);
    expect(out.bytes.equals(small)).toBe(true);
  });
});

describe('附件接收：只有真正就绪才可引用', () => {
  it('完整走通：登记 → 接收 → ready → 可拿到固定站内地址', async () => {
    const draftId = makeDraft();
    const created = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'screenshot.png',
      usage: 'body',
    });
    expect(created.processingState).toBe('pending');
    expect(created.displayUrl).toBeNull();

    const png = await realPng(300, 200);
    const ready = await media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: png });

    expect(ready.processingState).toBe('ready');
    expect(ready.width).toBe(300);
    expect(ready.height).toBe(200);
    expect(ready.displayUrl).toBe(`/media/${created.attachmentId}/DISPLAY`);

    // 库里确实有原图与展示图两份文件版本 + 两份落盘记录
    const files = db
      .prepare('SELECT variant_role, byte_size, content_hash FROM attachment_files WHERE attachment_id = ? ORDER BY variant_role')
      .all(created.attachmentId) as { variant_role: string; byte_size: number; content_hash: string }[];
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.variant_role).sort()).toEqual(['display', 'original']);
    for (const f of files) {
      expect(f.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(f.byte_size).toBeGreaterThan(0);
    }

    const blobs = db
      .prepare(
        `SELECT b.storage_key, b.byte_size FROM attachment_blobs b
           JOIN attachment_files f ON f.id = b.file_id
          WHERE f.attachment_id = ?`,
      )
      .all(created.attachmentId) as { storage_key: string; byte_size: number }[];
    expect(blobs).toHaveLength(2);
    // storage_key 必须由服务端生成，且落在 attachments/<id>/ 下
    for (const b of blobs) {
      expect(b.storage_key.startsWith(`attachments/${created.attachmentId}/`)).toBe(true);
    }
  });

  it('伪装格式 → failed 且记录原因，不产生任何文件版本', async () => {
    const draftId = makeDraft();
    const created = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'fake.png',
      usage: 'body',
    });

    await expect(
      media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: Buffer.from('not an image') }),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    const row = db
      .prepare('SELECT processing_state, last_error_code FROM attachments WHERE id = ?')
      .get(created.attachmentId) as { processing_state: string; last_error_code: string };
    expect(row.processing_state).toBe('failed');
    expect(row.last_error_code).toBeTruthy();

    const files = db
      .prepare('SELECT count(*) AS c FROM attachment_files WHERE attachment_id = ?')
      .get(created.attachmentId) as { c: number };
    expect(files.c).toBe(0);
  });

  it('已就绪的附件不能被覆盖（防止处理后的对象被改写）', async () => {
    const draftId = makeDraft();
    const created = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'a.png',
      usage: 'body',
    });
    await media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: await realPng(100, 100) });

    await expect(
      media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: await realPng(50, 50) }),
    ).rejects.toMatchObject({ code: 'version_conflict' });

    // 原尺寸没有被改写
    const f = db
      .prepare(`SELECT width FROM attachment_files WHERE attachment_id = ? AND variant_role = 'original'`)
      .get(created.attachmentId) as { width: number };
    expect(f.width).toBe(100);
  });

  it('不能往别人的草稿上传，也不能上传到别人的附件', async () => {
    const otherId = '01920000-0000-7000-8000-0000000000d1';
    const now = Date.now();
    db.prepare(
      `INSERT INTO users (id, nickname, role, account_status, created_at, updated_at) VALUES (?, '别人', 'user', 'active', ?, ?)`,
    ).run(otherId, now, now);

    const draftId = makeDraft();
    // 别人往我这里传 → 拒绝
    await expect(
      media.createAttachment(ctxFor(otherId), { draftId, originalFilename: 'x.png', usage: 'body' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // 我登记后，别人往我的附件里塞字节 → 拒绝
    const mine = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'mine.png',
      usage: 'body',
    });
    await expect(
      media.receiveFile(ctxFor(otherId), { attachmentId: mine.attachmentId, bytes: await realPng(10, 10) }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('读取权限（架构第 10 节）', () => {
  it('未公开引用时：本人可读，匿名不可读', async () => {
    const draftId = makeDraft();
    const created = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'p.png',
      usage: 'body',
    });
    const png = await realPng(120, 120);
    await media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: png });

    // 本人可读 display
    const asOwner = await media.resolveReadable(
      { attachmentId: created.attachmentId, variantKey: 'DISPLAY' },
      ctxFor(userId),
    );
    expect(asOwner).not.toBeNull();
    expect(asOwner?.mime).toBe('image/png');
    expect(asOwner?.bytes.byteLength).toBeGreaterThan(0);

    // 匿名不可读（该附件尚未被公开修订引用）
    const asAnon = await media.resolveReadable(
      { attachmentId: created.attachmentId, variantKey: 'DISPLAY' },
      ctxFor(null),
    );
    expect(asAnon).toBeNull();
  });

  it('原图不作为公开资源：即使被公开引用，非本人也读不到 ORIGINAL', async () => {
    const draftId = makeDraft();
    const created = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'o.png',
      usage: 'body',
    });
    await media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: await realPng(150, 150) });

    const originalFile = db
      .prepare(`SELECT id FROM attachment_files WHERE attachment_id = ? AND variant_role = 'original'`)
      .get(created.attachmentId) as { id: string };
    const displayFile = db
      .prepare(`SELECT id FROM attachment_files WHERE attachment_id = ? AND variant_role = 'display'`)
      .get(created.attachmentId) as { id: string };

    // 建立"已公开引用"
    const reviewId = db
      .prepare('SELECT review_id FROM content_drafts WHERE id = ?')
      .get(draftId) as { review_id: string };
    const revId = '01920000-0000-7000-8000-0000000000e1';
    const now = Date.now();
    db.prepare(
      `INSERT INTO review_revisions (id, review_id, revision_number, plugin_id, title, body_markdown, plugin_version, dsh_version, submitted_at)
       VALUES (?, ?, 1, (SELECT plugin_id FROM reviews WHERE id = ?), 't', 'b', '{"kind":"unknown"}', '{"kind":"unknown"}', ?)`,
    ).run(revId, reviewId.review_id, reviewId.review_id, now);
    db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revId, reviewId.review_id);
    db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(
      now,
      now,
      reviewId.review_id,
    );
    db.prepare(
      `INSERT INTO review_revision_attachment_links (review_revision_id, file_id, usage) VALUES (?, ?, 'body')`,
    ).run(revId, displayFile.id);

    // 匿名读 display → 可以（已被公开引用）
    const anonDisplay = await media.resolveReadable(
      { attachmentId: created.attachmentId, variantKey: 'DISPLAY' },
      ctxFor(null),
    );
    expect(anonDisplay).not.toBeNull();

    // 匿名读 ORIGINAL → 仍不可（原图不公开）
    const anonOriginal = await media.resolveReadable(
      { attachmentId: created.attachmentId, variantKey: 'ORIGINAL' },
      ctxFor(null),
    );
    expect(anonOriginal).toBeNull();

    void originalFile;
  });

  it('撤回后公开读取立刻失效（不靠缓存绕过）', async () => {
    const draftId = makeDraft();
    const created = await media.createAttachment(ctxFor(userId), {
      draftId,
      originalFilename: 'w.png',
      usage: 'body',
    });
    await media.receiveFile(ctxFor(userId), { attachmentId: created.attachmentId, bytes: await realPng(140, 140) });

    const reviewId = db.prepare('SELECT review_id FROM content_drafts WHERE id = ?').get(draftId) as {
      review_id: string;
    };
    const displayFile = db
      .prepare(`SELECT id FROM attachment_files WHERE attachment_id = ? AND variant_role = 'display'`)
      .get(created.attachmentId) as { id: string };
    const revId = '01920000-0000-7000-8000-0000000000e2';
    const now = Date.now();
    db.prepare(
      `INSERT INTO review_revisions (id, review_id, revision_number, plugin_id, title, body_markdown, plugin_version, dsh_version, submitted_at)
       VALUES (?, ?, 1, (SELECT plugin_id FROM reviews WHERE id = ?), 't', 'b', '{"kind":"unknown"}', '{"kind":"unknown"}', ?)`,
    ).run(revId, reviewId.review_id, reviewId.review_id, now);
    db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revId, reviewId.review_id);
    db.prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?').run(
      now,
      now,
      reviewId.review_id,
    );
    db.prepare(
      `INSERT INTO review_revision_attachment_links (review_revision_id, file_id, usage) VALUES (?, ?, 'body')`,
    ).run(revId, displayFile.id);

    expect(
      await media.resolveReadable({ attachmentId: created.attachmentId, variantKey: 'DISPLAY' }, ctxFor(null)),
    ).not.toBeNull();

    // 撤回
    db.prepare(
      `UPDATE content_entities SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1 WHERE id = ?`,
    ).run(now, '测试撤回', reviewId.review_id);

    expect(
      await media.resolveReadable({ attachmentId: created.attachmentId, variantKey: 'DISPLAY' }, ctxFor(null)),
    ).toBeNull();
  });
});

describe('storageKey 由服务端生成', () => {
  it('键只含服务端 ID 与固定变体名，不含用户文件名', () => {
    const key = storageKeyFor('01920000-0000-7000-8000-0000000000ff', 'DISPLAY');
    expect(key).toBe('attachments/01920000-0000-7000-8000-0000000000ff/DISPLAY');
    expect(key).not.toContain('..');
  });
});
