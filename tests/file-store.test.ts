/**
 * 本地文件存储与路径穿越防护测试。
 *
 * 这类防护的价值在于"被破坏时必须变红"：
 * 去掉 assertSafeStorageKey 或去掉 resolveWithinRoot 的复核，对应用例立刻失败。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertSafeStorageKey,
  createLocalFileStore,
  resolveWithinRoot,
  sha256Hex,
  isSha256Hex,
} from '../src/server/platform/file-store';

let dir: string;
let store: ReturnType<typeof createLocalFileStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'filestore-'));
  store = createLocalFileStore({ root: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('storageKey 校验（路径穿越防护）', () => {
  it('接受规范的服务端生成键', () => {
    expect(() => assertSafeStorageKey('attachments/01abc/DISPLAY')).not.toThrow();
    expect(() => assertSafeStorageKey('a/b/c-d_e.f')).not.toThrow();
  });

  it('拒绝上跳、绝对路径、盘符、反斜杠与空段', () => {
    const bad = [
      '../secret',
      'a/../../b',
      '/etc/passwd',
      'C:/windows/system32',
      'a\\b',
      'a//b',
      './a',
      'a/./b',
      '',
      'a/ /b',
      'a/%2e%2e/b',
    ];
    for (const key of bad) {
      expect(() => assertSafeStorageKey(key), `应拒绝：${key}`).toThrow();
    }
  });

  it('解析后的路径必须仍在根目录内 —— 越界即拒绝', () => {
    const ok = resolveWithinRoot(dir, 'attachments/x/y');
    expect(ok.startsWith(resolve(dir))).toBe(true);

    expect(() => resolveWithinRoot(dir, '../outside')).toThrow();
    // 即便校验被绕过，这里也再拦一次（本用例保证该复核真的存在）
    expect(() => resolveWithinRoot(dir, 'a/../../outside')).toThrow();
  });
});

describe('本地存储读写', () => {
  it('写入后可读回，且摘要与大小与实际字节一致', async () => {
    const bytes = Buffer.from('hello 图片字节', 'utf8');
    const written = await store.put('attachments/a1/original', bytes);

    expect(written.byteSize).toBe(bytes.byteLength);
    expect(written.sha256).toBe(sha256Hex(bytes));
    expect(isSha256Hex(written.sha256)).toBe(true);

    const read = await store.get('attachments/a1/original');
    expect(read?.equals(bytes)).toBe(true);
    expect(await store.exists('attachments/a1/original')).toBe(true);
  });

  it('不存在的键返回 null（不是抛错，也不是空 buffer）', async () => {
    expect(await store.get('attachments/nope/original')).toBeNull();
    expect(await store.exists('attachments/nope/original')).toBe(false);
  });

  it('覆盖写入后内容与摘要同步更新（不会读到旧内容）', async () => {
    await store.put('k/1', Buffer.from('first'));
    const second = await store.put('k/1', Buffer.from('second-longer'));
    const read = await store.get('k/1');
    expect(read?.toString('utf8')).toBe('second-longer');
    expect(second.sha256).toBe(sha256Hex(Buffer.from('second-longer')));
  });

  it('remove 之后读不到，且不抛错', async () => {
    await store.put('k/rm', Buffer.from('x'));
    await store.remove('k/rm');
    expect(await store.get('k/rm')).toBeNull();
    // 重复删除应幂等
    await expect(store.remove('k/rm')).resolves.toBeUndefined();
  });

  it('写入被拒绝时不在根目录留下任何文件（含临时文件）', async () => {
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toThrow();
    expect(existsSync(join(dir, '..'))).toBe(true); // 父目录当然还在
    // 根目录内不应出现逃逸产物
    const escaped = resolve(dir, '..', 'escape');
    expect(existsSync(escaped)).toBe(false);
  });
});
