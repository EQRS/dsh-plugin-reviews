/**
 * 收录时"插件在子目录"的提示（2026-10-19 来自真实误报）。
 *
 * 背景：volcengine/OpenViking 的 DSH 插件在 examples/dsh-memory-plugin/，
 * 作者只填了仓库根链接，站点报「该目录下的 package.json 没有声明 dsh.bundle」，
 * 读起来像"这仓库不是 DSH 插件"，实际只是路径没指到。
 *
 * 每个用例都能在实现被破坏时变红：
 *  - 去掉 findPluginDirs 分支 → 前两条用例退回"未声明"的旧文案，失败；
 *  - 把"唯一候选"也当多候选处理 → 第一条用例失败；
 *  - 探测抛错不兜住 → 最后一条用例失败。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { repoInfoStub } from './support/probe';
import { createCatalogService } from '../src/server/modules/catalog/service';
import { isDomainError } from '../src/packages/common/errors';
import type { CallerContextLike, CatalogProbe } from '../src/server/modules/catalog/types';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function activeCaller(userId: string): CallerContextLike {
  return { userId, role: 'user', accountStatus: 'active' };
}

/** 根目录没有清单的探针；findPluginDirs 的行为由参数决定。 */
function subdirProbe(options: { dirs?: string[]; throws?: boolean; withoutMethod?: boolean }): CatalogProbe {
  const base: CatalogProbe = {
    async fetchRepository() {
      return repoInfoStub({ githubRepositoryId: '9101', isArchived: false });
    },
    async fetchPluginManifest() {
      return null;
    },
  };
  if (options.withoutMethod) return base;
  return {
    ...base,
    async findPluginDirs() {
      if (options.throws) throw new Error('探测失败');
      return options.dirs ?? [];
    },
  };
}

async function submit(probe: CatalogProbe, url: string): Promise<{ code: string; message: string }> {
  const testDb = createTestDb();
  ctx = testDb;
  const service = createCatalogService({ db: testDb.db });
  const userId = insertUser(testDb.db);
  try {
    await service.acceptPluginSubmission(
      activeCaller(userId),
      { url, requestKey: `rk-${Math.random()}` },
      { probe },
    );
    throw new Error('预期被拒，但成功了');
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return { code: e.code, message: e.message };
  }
}

describe('填了仓库根链接、插件其实在子目录', () => {
  it('只有一个候选：直接给出子目录和完整链接', async () => {
    const r = await submit(subdirProbe({ dirs: ['examples/dsh-memory-plugin'] }), 'https://github.com/volcengine/OpenViking');
    expect(r.code).toBe('input_invalid');
    expect(r.message).toContain('examples/dsh-memory-plugin');
    expect(r.message).toContain('https://github.com/volcengine/OpenViking/tree/HEAD/examples/dsh-memory-plugin');
  });

  it('多个候选：列出全部，请作者自己选', async () => {
    const r = await submit(subdirProbe({ dirs: ['examples/a', 'examples/b'] }), 'https://github.com/x/y');
    expect(r.code).toBe('input_invalid');
    expect(r.message).toContain('examples/a');
    expect(r.message).toContain('examples/b');
  });

  it('一个候选都没有：回到「未声明 dsh.bundle」，不编造路径', async () => {
    const r = await submit(subdirProbe({ dirs: [] }), 'https://github.com/x/y');
    expect(r.code).toBe('input_invalid');
    expect(r.message).toContain('没有声明 dsh.bundle');
  });

  it('探测抛错时仍按原理由拒绝，不把错误盖成 500', async () => {
    const r = await submit(subdirProbe({ throws: true }), 'https://github.com/x/y');
    expect(r.code).toBe('input_invalid');
  });

  it('探针没实现探测方法时照旧拒绝', async () => {
    const r = await submit(subdirProbe({ withoutMethod: true }), 'https://github.com/x/y');
    expect(r.code).toBe('input_invalid');
    expect(r.message).toContain('没有声明 dsh.bundle');
  });
});
