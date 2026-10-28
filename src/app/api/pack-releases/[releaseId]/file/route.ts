/**
 * 作者上传整合包文件：进入待审核（不分配发布序号，不公开）。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { newId } from '@/server/platform/id';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(['.zip', '.json', '.md', '.txt', '.yaml', '.yml']);
const DATA_ROOT = join(process.cwd(), 'data', 'packs');

function safeFileName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(-120) || 'pack.zip';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  let dir: string | null = null;
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const form = await request.formData();
    const upload = form.get('file');
    if (!(upload instanceof File) || upload.size === 0) {
      throw err.input('请选择要上传的整合包文件。', [{ path: 'file', message: '必填' }]);
    }
    if (upload.size > MAX_BYTES) {
      throw err.input('整合包文件不能超过 10MB。', [{ path: 'file', message: '超过 10MB' }]);
    }
    const ext = (upload.name.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw err.input('只接受 zip / json / md / txt / yaml 文件。', [{ path: 'file', message: '类型不支持' }]);
    }
    const name = safeFileName(upload.name || 'pack.zip');
    dir = join(DATA_ROOT, newId());
    await mkdir(dir, { recursive: true });
    const storedPath = join(dir, name);
    await writeFile(storedPath, Buffer.from(await upload.arrayBuffer()));

    const service = createPacksService({ db: getDb() });
    const result = await service.uploadReleaseFile(ctx, releaseId, {
      fileName: name,
      byteSize: upload.size,
      storedPath,
    });
    return okJson(result, requestId, 201);
  } catch (e) {
    if (dir) await rm(dir, { recursive: true, force: true });
    return errorResponse(e, requestId);
  }
}
