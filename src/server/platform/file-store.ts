/**
 * 本地文件存储（依赖与 Linux 部署第 3、6 节：持久目录 + 本地保底）。
 *
 * 铁律：
 *  1. **storage_key 由服务端生成**，绝不用用户提供的文件名拼路径；
 *  2. 解析后的绝对路径必须仍在根目录内，否则拒绝（路径穿越防护）；
 *  3. 写入用「临时文件 + rename」，保证读取方永远不会看到半截文件；
 *  4. 写入后**回读校验摘要与大小**，不一致即视为失败，不把坏文件当成可用载荷。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface StoredObject {
  storageKey: string;
  byteSize: number;
  sha256: string;
}

export interface FileStore {
  /** 写入一份载荷并返回实际大小与摘要（已回读校验）。 */
  put(storageKey: string, bytes: Buffer): Promise<StoredObject>;
  /** 读取载荷；不存在返回 null。 */
  get(storageKey: string): Promise<Buffer | null>;
  exists(storageKey: string): Promise<boolean>;
  remove(storageKey: string): Promise<void>;
  /** 该 key 解析到的绝对路径（仅供诊断与日志，不对外暴露）。 */
  resolvePath(storageKey: string): string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 校验 storageKey：只允许「相对路径 + 正斜杠 + 安全字符」。
 * 显式拒绝绝对路径、盘符、`..`、反斜杠与空段，避免任何形式的上跳。
 */
export function assertSafeStorageKey(storageKey: string): void {
  if (typeof storageKey !== 'string' || storageKey.trim().length === 0) {
    throw new Error('storageKey 不能为空');
  }
  if (isAbsolute(storageKey)) {
    throw new Error(`storageKey 不允许绝对路径：${storageKey}`);
  }
  if (storageKey.includes('\\')) {
    throw new Error(`storageKey 不允许反斜杠：${storageKey}`);
  }
  if (/^[a-zA-Z]:/.test(storageKey)) {
    throw new Error(`storageKey 不允许盘符：${storageKey}`);
  }
  const segments = storageKey.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`storageKey 含非法路径段：${storageKey}`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
      throw new Error(`storageKey 含非法字符：${storageKey}`);
    }
  }
}

/**
 * 把 storageKey 解析为根目录内的绝对路径。
 * 即使 assertSafeStorageKey 已挡住非法输入，这里仍再做一次"解析后必须仍在根内"的复核，
 * 因为规范化行为（大小写、符号链接语义）不该由单点判断承担。
 */
export function resolveWithinRoot(root: string, storageKey: string): string {
  assertSafeStorageKey(storageKey);
  const absRoot = resolve(root);
  const candidate = resolve(absRoot, storageKey);
  const rel = relative(absRoot, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`解析结果越出存储根目录，已拒绝：${storageKey}`);
  }
  return candidate;
}

export interface LocalFileStoreOptions {
  /** 存储根目录；默认 .data/media（与 db 同属持久目录）。 */
  root: string;
}

/** 本地持久目录实现（首版本的保底实现，可独立工作）。 */
export function createLocalFileStore(options: LocalFileStoreOptions): FileStore {
  const root = resolve(options.root);

  return {
    resolvePath(storageKey: string): string {
      return resolveWithinRoot(root, storageKey);
    },

    async put(storageKey: string, bytes: Buffer): Promise<StoredObject> {
      const target = resolveWithinRoot(root, storageKey);
      await mkdir(dirname(target), { recursive: true });

      // 临时文件与目标同目录，保证 rename 是同一文件系统内的原子操作。
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      const expectedHash = sha256Hex(bytes);
      const expectedSize = bytes.byteLength;

      try {
        await writeFile(tmp, bytes, { flag: 'wx' });
        await rename(tmp, target);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }

      // 回读校验：落盘后真实字节必须与写入内容一致，否则不能算成功。
      const back = await readFile(target);
      const actualHash = sha256Hex(back);
      if (back.byteLength !== expectedSize || actualHash !== expectedHash) {
        await rm(target, { force: true }).catch(() => undefined);
        throw new Error(
          `落盘校验失败：期望 ${expectedSize}/${expectedHash.slice(0, 12)}，实际 ${back.byteLength}/${actualHash.slice(0, 12)}`,
        );
      }

      return { storageKey, byteSize: expectedSize, sha256: actualHash };
    },

    async get(storageKey: string): Promise<Buffer | null> {
      const target = resolveWithinRoot(root, storageKey);
      try {
        return await readFile(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    async exists(storageKey: string): Promise<boolean> {
      const target = resolveWithinRoot(root, storageKey);
      try {
        const s = await stat(target);
        return s.isFile();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw e;
      }
    },

    async remove(storageKey: string): Promise<void> {
      const target = resolveWithinRoot(root, storageKey);
      await rm(target, { force: true });
    },
  };
}

/** 正确的 sha256 形状判断（供模块层校验数据库取出的摘要）。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** 默认媒体根目录：与数据库同属 .data 持久目录。 */
export function defaultMediaRoot(): string {
  return process.env.DSH_REVIEW_MEDIA_ROOT?.trim() || join(resolve(process.cwd(), '.data'), 'media');
}
