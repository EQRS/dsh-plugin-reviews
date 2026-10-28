/**
 * 整合包（`idea.md` §26/§27；`架构设计.md` §15/§35/§36/§58/§88；决策记录 11/12）。
 *
 * 三条不可让的不变量：
 *  1. **发布即冻结**：`plugin_pack_releases` 一旦拿到 `release_number`，名称/用途/说明/
 *     DSH 版本/配置模板/实测声明/条目全部不再原位修改；改内容只能发新版。
 *  2. **版本是公共内容对象**：`release.id` 同时是 `content_entities.id`（`pack_release`），
 *     评论与举报绑定具体版本；可见性只由公共表 + 发布序号共同决定（不另存"公开"列）。
 *  3. **命令是派生物**：条目只存结构化 `install_target`，命令由 `pack-install` 适配器生成；
 *     目标不确认就没有命令（`pendingReason` 说明原因），绝不猜。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';
import { buildPage, type PageRequest, type PageResult } from '@/packages/common/result';
import {
  buildInstallCommands,
  normalizeInstallTarget,
  describeInstallTarget,
  type CommandBundle,
  type CommandOutputItem,
  type InstallTarget,
} from '@/packages/common/pack-install';

const TITLE_MAX = 80;
const PURPOSE_MAX = 2000;
const BODY_MAX = 200_000;
const CONFIG_MAX = 20_000;
const ITEM_PURPOSE_MAX = 200;
const MAX_ITEMS = 50;

export interface PackItemInput {
  pluginId: string;
  purpose?: string | null;
  pluginVersion: VersionValue;
  installTarget: InstallTarget | null;
  sourceUrl?: string | null;
}

export interface ReleaseInput {
  title: string;
  purpose: string;
  bodyMarkdown: string;
  dshVersion: VersionValue;
  configTemplate?: string | null;
  testStatus: 'untested' | 'tested';
  testTask?: string | null;
  testResult?: string | null;
  items: PackItemInput[];
}

export interface PackSummaryView {
  packId: string;
  authorNickname: string;
  title: string;
  purpose: string;
  releaseNumber: number | null;
  releaseId: string;
  pluginCount: number;
  favoriteCount: number;
  publishedAt: number;
  /** 仅「我的整合包」使用：最近版本当前是否仍公开。 */
  withdrawn?: boolean;
  hidden?: boolean;
  /** 版本生命周期：draft（未上传）/ pending（待审核）/ published / rejected。 */
  reviewStatus?: 'draft' | 'pending' | 'published' | 'rejected';
  reviewNote?: string | null;
}

export interface PackReleaseSummary {
  releaseId: string;
  releaseNumber: number | null;
  title: string;
  submittedAt: number;
  withdrawn: boolean;
  hidden: boolean;
}

export interface PackItemView extends CommandOutputItem {
  position: number;
  pluginId: string;
  purpose: string | null;
  sourceUrl: string | null;
  pluginPath: string | null;
  repositoryFullName: string | null;
  /** 结构化目标的展示摘要（无目标时为空）。 */
  targetLabel: string | null;
  displaySnapshot: { displayName: string | null; repositoryFullName: string | null; pluginPath: string | null };
}

export interface PackReleaseDetail {
  releaseId: string;
  releaseNumber: number;
  title: string;
  purpose: string;
  bodyMarkdown: string;
  dshVersion: VersionValue;
  configTemplate: string | null;
  testStatus: 'untested' | 'tested';
  testTask: string | null;
  testResult: string | null;
  publishedAt: number;
  withdrawn: boolean;
  hidden: boolean;
  items: PackItemView[];
  commands: CommandBundle;
}

export interface PackDetailView {
  packId: string;
  authorId: string;
  authorNickname: string;
  favoriteCount: number;
  favoritedByMe: boolean;
  releases: PackReleaseSummary[];
  /** 默认入口选中的版本；全部版本都不公开时为 null。 */
  selected: PackReleaseDetail | null;
  /** 请求了指定版本但它不公开 —— 页面要显示状态，而不是悄悄换成别的版本（§88.2）。 */
  requestedUnavailable: boolean;
  /** 默认入口发生了回退（最近版本被撤回/隐藏，展示的是更早的版本）。 */
  fellBack: boolean;
}

/** 版本结构校验：允许明确未知，但已知值必须是有内容的短文本。 */
function parseVersionValue(raw: unknown, field: string): VersionValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err.input(`${field} 必须是版本对象。`, [{ path: field, message: '格式不合法' }]);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'unknown') return { kind: 'unknown' };
  const value = typeof obj.value === 'string' ? obj.value.trim() : '';
  if (obj.kind !== 'known' || value.length === 0 || value.length > 100) {
    throw err.input(`${field} 的版本值需为 1–100 个字符。`, [{ path: field, message: '长度不合法' }]);
  }
  const source = typeof obj.source === 'string' && obj.source.trim().length > 0 ? obj.source.trim() : undefined;
  return source ? { kind: 'known', value, source } : { kind: 'known', value };
}

function requireText(value: unknown, field: string, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > max) {
    throw err.input(`${label}需为 1–${max} 个字符。`, [{ path: field, message: `1–${max} 个字符` }]);
  }
  return text;
}

/** 解析并校验整份版本输入（创建与发新版共用）。 */
function parseReleaseInput(
  conn: SqliteDatabase,
  input: ReleaseInput,
): {
  title: string;
  purpose: string;
  bodyMarkdown: string;
  dshVersion: VersionValue;
  configTemplate: string | null;
  testStatus: 'untested' | 'tested';
  testTask: string | null;
  testResult: string | null;
  items: Array<{
    pluginId: string;
    position: number;
    purpose: string | null;
    displaySnapshot: string;
    pluginVersion: VersionValue;
    installTarget: InstallTarget | null;
    sourceUrl: string | null;
  }>;
} {
  const title = requireText(input.title, 'title', '整合包名称', TITLE_MAX);
  const purpose = requireText(input.purpose, 'purpose', '用途说明', PURPOSE_MAX);
  const bodyMarkdown = typeof input.bodyMarkdown === 'string' ? input.bodyMarkdown.trim() : '';
  if (bodyMarkdown.length === 0 || bodyMarkdown.length > BODY_MAX) {
    throw err.input(`组合使用说明需为 1–${BODY_MAX} 个字符。`, [{ path: 'bodyMarkdown', message: '长度不合法' }]);
  }
  const dshVersion = parseVersionValue(input.dshVersion, 'dshVersion');

  let configTemplate: string | null = null;
  if (typeof input.configTemplate === 'string' && input.configTemplate.trim().length > 0) {
    const value = input.configTemplate.trim();
    if (value.length > CONFIG_MAX) {
      throw err.input(`配置模板最多 ${CONFIG_MAX} 个字符。`, [{ path: 'configTemplate', message: '过长' }]);
    }
    configTemplate = value;
  }

  const testStatus = input.testStatus === 'tested' ? 'tested' : 'untested';
  let testTask: string | null = null;
  let testResult: string | null = null;
  if (testStatus === 'tested') {
    testTask = requireText(input.testTask, 'testTask', '测试任务', 2000);
    testResult = requireText(input.testResult, 'testResult', '测试结果', 2000);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw err.input('整合包至少要有一个插件。', [{ path: 'items', message: '不能为空' }]);
  }
  if (input.items.length > MAX_ITEMS) {
    throw err.input(`整合包最多 ${MAX_ITEMS} 个插件。`, [{ path: 'items', message: '过多' }]);
  }

  const seen = new Set<string>();
  const items = input.items.map((raw, index) => {
    const pluginId = typeof raw.pluginId === 'string' ? raw.pluginId.trim() : '';
    if (pluginId.length === 0) {
      throw err.input(`第 ${index + 1} 个条目缺少插件。`, [{ path: `items[${index}].pluginId`, message: '必填' }]);
    }
    if (seen.has(pluginId)) {
      throw err.input('同一个插件在清单里只能出现一次。', [{ path: `items[${index}].pluginId`, message: '重复' }]);
    }
    seen.add(pluginId);

    const plugin = conn
      .prepare(
        `SELECT p.id, p.plugin_path, r.full_name
           FROM plugins p JOIN repositories r ON r.id = p.repository_id
          WHERE p.id = ?`,
      )
      .get(pluginId) as { id: string; plugin_path: string; full_name: string } | undefined;
    if (!plugin) throw err.unavailable(`第 ${index + 1} 个条目的插件不存在。`);

    let itemPurpose: string | null = null;
    if (typeof raw.purpose === 'string' && raw.purpose.trim().length > 0) {
      itemPurpose = raw.purpose.trim();
      if (itemPurpose.length > ITEM_PURPOSE_MAX) {
        throw err.input(`每个插件的作用说明最多 ${ITEM_PURPOSE_MAX} 个字符。`, [
          { path: `items[${index}].purpose`, message: '过长' },
        ]);
      }
    }

    let sourceUrl: string | null = null;
    if (typeof raw.sourceUrl === 'string' && raw.sourceUrl.trim().length > 0) {
      sourceUrl = raw.sourceUrl.trim();
      if (sourceUrl.length > 500 || !/^https?:\/\//i.test(sourceUrl)) {
        throw err.input('来源链接必须是 http(s) 地址（≤500 字）。', [
          { path: `items[${index}].sourceUrl`, message: '格式不合法' },
        ]);
      }
    }

    let installTarget: InstallTarget | null = null;
    if (raw.installTarget !== null && raw.installTarget !== undefined) {
      installTarget = normalizeInstallTarget(raw.installTarget);
      if (installTarget === null) {
        throw err.input('安装目标的资料不完整或格式不合法；无法确认时请留空（会显示「待核实」）。', [
          { path: `items[${index}].installTarget`, message: '格式不合法' },
        ]);
      }
    }

    return {
      pluginId,
      position: index,
      purpose: itemPurpose,
      displaySnapshot: JSON.stringify({
        displayName: null,
        repositoryFullName: plugin.full_name,
        pluginPath: plugin.plugin_path,
      }),
      pluginVersion: parseVersionValue(raw.pluginVersion, `items[${index}].pluginVersion`),
      installTarget,
      sourceUrl,
    };
  });

  return {
    title,
    purpose,
    bodyMarkdown,
    dshVersion,
    configTemplate,
    testStatus,
    testTask,
    testResult,
    items,
  };
}

interface ReleaseRow {
  id: string;
  pack_id: string;
  release_number: number | null;
  title: string;
  purpose: string;
  body_markdown: string;
  dsh_version: string;
  config_template: string | null;
  test_status: 'untested' | 'tested';
  test_task: string | null;
  test_result: string | null;
  submitted_at: number;
  withdrawn_at: number | null;
  hidden_at: number | null;
}

/** 公共表的可见性字段（与 content 模块同一判据的读取侧）。 */
function readReleaseRow(conn: SqliteDatabase, releaseId: string): ReleaseRow | undefined {
  return conn
    .prepare(
      `SELECT rel.id, rel.pack_id, rel.release_number, rel.title, rel.purpose, rel.body_markdown,
              rel.dsh_version, rel.config_template, rel.test_status, rel.test_task, rel.test_result,
              rel.submitted_at, ce.withdrawn_at, ce.hidden_at
         FROM plugin_pack_releases rel
         JOIN content_entities ce ON ce.id = rel.id
        WHERE rel.id = ?`,
    )
    .get(releaseId) as ReleaseRow | undefined;
}

function isPublicRelease(row: ReleaseRow): boolean {
  return row.release_number !== null && row.withdrawn_at === null && row.hidden_at === null;
}

export function createPacksService(deps: { db?: SqliteDatabase } = {}) {
  const db = deps.db ?? getDb();

  /** 生成一条条目视图（含命令与展示资料快照）。 */
  function toItemView(row: {
    id: string;
    plugin_id: string;
    position: number;
    purpose: string | null;
    display_snapshot: string;
    plugin_version: string;
    install_target: string | null;
    source_url: string | null;
    plugin_path: string | null;
    full_name: string | null;
  }): CommandOutputItem & {
    position: number;
    pluginId: string;
    purpose: string | null;
    sourceUrl: string | null;
    pluginPath: string | null;
    repositoryFullName: string | null;
    targetLabel: string | null;
    displaySnapshot: PackItemView['displaySnapshot'];
  } {
    const snapshot = JSON.parse(row.display_snapshot) as PackItemView['displaySnapshot'];
    const version = JSON.parse(row.plugin_version) as VersionValue;
    const rawTarget = row.install_target === null ? null : (JSON.parse(row.install_target) as unknown);
    const target = normalizeInstallTarget(rawTarget);
    const bundle = buildInstallCommands([
      // 传 `kind: 'unknown'` 的 displayName 由快照决定，这里只借它算命令
      {
        pluginId: row.plugin_id,
        displayName: snapshot.displayName ?? snapshot.repositoryFullName ?? row.plugin_id,
        pluginVersion: version,
        installTarget: target,
        sourceUrl: row.source_url,
      },
    ]);
    const computed = bundle.items[0]!;
    return {
      ...computed,
      position: row.position,
      pluginId: row.plugin_id,
      purpose: row.purpose,
      sourceUrl: row.source_url,
      pluginPath: snapshot.pluginPath ?? row.plugin_path,
      repositoryFullName: snapshot.repositoryFullName ?? row.full_name,
      targetLabel: target === null ? null : describeInstallTarget(target),
      displaySnapshot: snapshot,
    };
  }

  return {
    /**
     * 创建整合包并立即发布第 1 版。
     *
     * 序号分配与内容写入在**同一个事务**里：`last_release_number` 与 `release_number`
     * 必须同时成立（架构 §58；事务回滚不消耗序号）。
     */
    async createPackWithFirstRelease(
      ctx: CallerContext,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ packId: string; releaseId: string; releaseNumber: number }> {
      assertCanWrite(ctx);
      const authorId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        const packId = newId(now);
        const releaseId = newId(now);

        conn.prepare('INSERT INTO plugin_packs (id, author_id, last_release_number, created_at) VALUES (?, ?, 0, ?)').run(
          packId,
          authorId,
          now,
        );
        conn
          .prepare(
            `INSERT INTO content_entities
               (id, content_type, author_id, review_id, pack_release_id, created_at,
                first_published_at, public_updated_at, visibility_control_version)
             VALUES (?, 'pack_release', ?, NULL, ?, ?, ?, ?, 0)`,
          )
          .run(releaseId, authorId, releaseId, now, now, now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_releases
               (id, pack_id, release_number, title, purpose, body_markdown, dsh_version,
                config_template, test_status, test_task, test_result, submitted_at, review_status)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
          )
          .run(
            releaseId,
            packId,
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
          );
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        conn.prepare('UPDATE plugin_packs SET last_release_number = 1 WHERE id = ?').run(packId);
        return { packId, releaseId, releaseNumber: 1 };
      }, injectedDb ?? db);
    },

    /**
     * 创建整合包草稿（不分配发布序号、不公开）。
     *
     * 作者上传整合包文件后才进入待审核；审核通过才分配「第 N 版」并公开。
     */
    async createPackDraft(
      ctx: CallerContext,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ packId: string; releaseId: string }> {
      assertCanWrite(ctx);
      const authorId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        const packId = newId(now);
        const releaseId = newId(now);

        conn
          .prepare('INSERT INTO plugin_packs (id, author_id, last_release_number, created_at) VALUES (?, ?, 0, ?)')
          .run(packId, authorId, now);
        conn
          .prepare(
            `INSERT INTO content_entities
               (id, content_type, author_id, review_id, pack_release_id, created_at,
                first_published_at, public_updated_at, visibility_control_version)
             VALUES (?, 'pack_release', ?, NULL, ?, ?, NULL, NULL, 0)`,
          )
          .run(releaseId, authorId, releaseId, now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_releases
               (id, pack_id, release_number, title, purpose, body_markdown, dsh_version,
                config_template, test_status, test_task, test_result, submitted_at, review_status)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
          )
          .run(
            releaseId,
            packId,
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
          );
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        return { packId, releaseId };
      }, injectedDb ?? db);
    },

    /** 作者上传整合包文件：进入待审核（不分配发布序号，不公开）。 */
    async uploadReleaseFile(
      ctx: CallerContext,
      releaseId: string,
      file: { fileName: string; byteSize: number; storedPath: string },
      injectedDb?: SqliteDatabase,
    ): Promise<{ reviewStatus: 'pending' }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.pack_id, rel.review_status, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | { id: string; pack_id: string; review_status: string; author_id: string }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以上传整合包。');
        if (rel.review_status === 'published') {
          throw err.conflict('这个版本已经发布，不能重新上传；请发布新版本。', { releaseId });
        }
        if (rel.review_status === 'pending') {
          throw err.conflict('这个版本已在审核中，请等待审核结果。', { releaseId });
        }

        const now = nowMs();
        conn
          .prepare(
            `INSERT INTO plugin_pack_release_files
               (id, release_id, file_name, byte_size, stored_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(newId(now), releaseId, file.fileName, file.byteSize, file.storedPath, now);
        conn
          .prepare(
            `UPDATE plugin_pack_releases
                SET review_status = 'pending', review_note = NULL, submitted_at = ?
              WHERE id = ?`,
          )
          .run(now, releaseId);
        return { reviewStatus: 'pending' as const };
      }, injectedDb ?? db);
    },

    /** 管理员审核通过：分配发布序号并公开（同一事务，§58）。 */
    async approveRelease(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ releaseNumber: number }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核整合包。');
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare('SELECT id, pack_id, review_status FROM plugin_pack_releases WHERE id = ?')
          .get(releaseId) as { id: string; pack_id: string; review_status: string } | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.review_status !== 'pending') {
          throw err.conflict('只有待审核版本可以通过审核。', { releaseId });
        }
        const pack = conn
          .prepare('SELECT last_release_number FROM plugin_packs WHERE id = ?')
          .get(rel.pack_id) as { last_release_number: number } | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');

        const releaseNumber = Number(pack.last_release_number) + 1;
        const now = nowMs();
        conn
          .prepare(
            `UPDATE plugin_pack_releases
                SET release_number = ?, review_status = 'published', review_note = NULL
              WHERE id = ?`,
          )
          .run(releaseNumber, releaseId);
        conn
          .prepare(
            `UPDATE content_entities
                SET first_published_at = COALESCE(first_published_at, ?), public_updated_at = ?
              WHERE id = ?`,
          )
          .run(now, now, releaseId);
        conn.prepare('UPDATE plugin_packs SET last_release_number = ? WHERE id = ?').run(releaseNumber, rel.pack_id);
        return { releaseNumber };
      }, injectedDb ?? db);
    },

    /** 管理员审核拒绝：记录原因，作者可修改后重新上传。 */
    async rejectRelease(
      ctx: CallerContext,
      releaseId: string,
      note: string | null,
      injectedDb?: SqliteDatabase,
    ): Promise<{ ok: true }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核整合包。');
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare('SELECT id, review_status FROM plugin_pack_releases WHERE id = ?')
          .get(releaseId) as { id: string; review_status: string } | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.review_status !== 'pending') {
          throw err.conflict('只有待审核版本可以拒绝。', { releaseId });
        }
        conn
          .prepare(`UPDATE plugin_pack_releases SET review_status = 'rejected', review_note = ? WHERE id = ?`)
          .run((note ?? '').trim() || null, releaseId);
        return { ok: true as const };
      }, injectedDb ?? db);
    },

    /** 作者编辑草稿/被拒版本（已发布版本不可改，需发新版）。 */
    async updateDraftRelease(
      ctx: CallerContext,
      releaseId: string,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ releaseId: string }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.pack_id, rel.review_status, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | { id: string; pack_id: string; review_status: string; author_id: string }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以编辑整合包。');
        if (rel.review_status === 'published') {
          throw err.conflict('已发布版本不可原地修改；请发布新版本。', { releaseId });
        }
        if (rel.review_status === 'pending') {
          throw err.conflict('版本正在审核中，不能编辑。', { releaseId });
        }

        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        conn
          .prepare(
            `UPDATE plugin_pack_releases
                SET title = ?, purpose = ?, body_markdown = ?, dsh_version = ?,
                    config_template = ?, test_status = ?, test_task = ?, test_result = ?,
                    submitted_at = ?
              WHERE id = ?`,
          )
          .run(
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
            releaseId,
          );
        conn.prepare('DELETE FROM plugin_pack_release_items WHERE release_id = ?').run(releaseId);
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        return { releaseId };
      }, injectedDb ?? db);
    },

    /** 作者删除未发布版本（草稿/待审/被拒）；已发布版本只能撤回。 */
    async deleteDraftRelease(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ deleted: true }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.pack_id, rel.review_status, rel.release_number, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | {
              id: string;
              pack_id: string;
              review_status: string;
              release_number: number | null;
              author_id: string;
            }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以删除整合包。');
        if (rel.review_status === 'published' || rel.release_number !== null) {
          throw err.conflict('已发布版本只能撤回，不能删除。', { releaseId });
        }
        // 先删版本（引用公共内容），再删公共内容行；items/files 随版本级联。
        conn.prepare('DELETE FROM plugin_pack_releases WHERE id = ?').run(releaseId);
        conn.prepare('DELETE FROM content_entities WHERE id = ?').run(releaseId);
        const rest = conn.prepare('SELECT COUNT(*) AS c FROM plugin_pack_releases WHERE pack_id = ?').get(rel.pack_id) as { c: number };
        if (Number(rest.c) === 0) {
          conn.prepare('DELETE FROM plugin_packs WHERE id = ?').run(rel.pack_id);
        }
        return { deleted: true as const };
      }, injectedDb ?? db);
    },

    /** 作者发布新版本：序号原子 +1，内容整份冻结；旧版本保持原样（§35.2/§58）。 */
    async addRelease(
      ctx: CallerContext,
      packId: string,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ releaseId: string; releaseNumber: number }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const pack = conn.prepare('SELECT author_id, last_release_number FROM plugin_packs WHERE id = ?').get(packId) as
          | { author_id: string; last_release_number: number }
          | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');
        if (pack.author_id !== userId) throw err.forbidden('只有作者可以发布新版本。');

        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        const releaseNumber = Number(pack.last_release_number) + 1;
        const releaseId = newId(now);

        conn
          .prepare(
            `INSERT INTO content_entities
               (id, content_type, author_id, review_id, pack_release_id, created_at,
                first_published_at, public_updated_at, visibility_control_version)
             VALUES (?, 'pack_release', ?, NULL, ?, ?, ?, ?, 0)`,
          )
          .run(releaseId, userId, releaseId, now, now, now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_releases
               (id, pack_id, release_number, title, purpose, body_markdown, dsh_version,
                config_template, test_status, test_task, test_result, submitted_at, review_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
          )
          .run(
            releaseId,
            packId,
            releaseNumber,
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
          );
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        conn.prepare('UPDATE plugin_packs SET last_release_number = ? WHERE id = ?').run(releaseNumber, packId);
        return { releaseId, releaseNumber };
      }, injectedDb ?? db);
    },

    /** 作者撤回某个版本（按版本撤回，不动其它版本；§26）。 */
    async withdrawRelease(
      ctx: CallerContext,
      packId: string,
      releaseId: string,
      reason: string | null,
      injectedDb?: SqliteDatabase,
    ): Promise<{ withdrawnAt: number }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const pack = conn.prepare('SELECT author_id FROM plugin_packs WHERE id = ?').get(packId) as
          | { author_id: string }
          | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');
        if (pack.author_id !== userId) throw err.forbidden('只有作者可以撤回版本。');
        const release = readReleaseRow(conn, releaseId);
        if (!release || release.pack_id !== packId) throw err.unavailable('版本不存在或不属于该整合包。');
        if (release.release_number === null) throw err.unavailable('这个版本还没有发布。');
        const now = nowMs();
        const changed = conn
          .prepare(
            `UPDATE content_entities
                SET withdrawn_at = ?, withdrawal_reason = ?,
                    visibility_control_version = visibility_control_version + 1
              WHERE id = ? AND withdrawn_at IS NULL AND hidden_at IS NULL`,
          )
          .run(now, (reason ?? '').trim() || '作者撤回（未填写原因）', releaseId);
        if (changed.changes === 0) throw err.conflict('这个版本已经不可公开了。', { releaseId });
        return { withdrawnAt: now };
      }, injectedDb ?? db);
    },

    /** 广场：一包一项，取「最近仍公开的版本」作为展示内容（§27/§88）。 */
    async listPublicPacks(
      req: Partial<PageRequest> & { q?: string } = {},
      injectedDb?: SqliteDatabase,
    ): Promise<PageResult<PackSummaryView>> {
      const pageRaw = req.page;
      const page = typeof pageRaw === 'number' && Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const sizeRaw = req.page_size;
      const pageSize = typeof sizeRaw === 'number' ? Math.min(Math.max(sizeRaw, 1), 50) : 20;
      const q = (req.q ?? '').trim().slice(0, 100);
      return withRead((conn) => {
        const like = q.length === 0 ? null : `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const where = like === null ? '' : `WHERE (l.title LIKE ? ESCAPE '\\' OR l.purpose LIKE ? ESCAPE '\\')`;
        const params: unknown[] = like === null ? [] : [like, like];

        const total = (conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (PARTITION BY rel.pack_id ORDER BY rel.release_number DESC) AS rn
                 FROM plugin_pack_releases rel
                 JOIN content_entities ce ON ce.id = rel.id
                WHERE rel.release_number IS NOT NULL AND rel.review_status = 'published'
                   AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL
             )
             SELECT COUNT(*) AS c FROM plugin_packs p JOIN latest l ON l.pack_id = p.id AND l.rn = 1 ${where}`,
          )
          .get(...params) as { c: number }).c;

        const rows = conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (PARTITION BY rel.pack_id ORDER BY rel.release_number DESC) AS rn
                 FROM plugin_pack_releases rel
                 JOIN content_entities ce ON ce.id = rel.id
                WHERE rel.release_number IS NOT NULL AND rel.review_status = 'published'
                   AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL
             )
             SELECT p.id AS pack_id, p.author_id, u.nickname, l.id AS release_id, l.release_number,
                    l.title, l.purpose, l.submitted_at,
                    (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = l.id) AS item_count,
                    (SELECT COUNT(*) FROM plugin_pack_favorites f WHERE f.pack_id = p.id) AS favorite_count
               FROM plugin_packs p
               JOIN latest l ON l.pack_id = p.id AND l.rn = 1
               JOIN users u ON u.id = p.author_id
               ${where}
              ORDER BY l.submitted_at DESC, p.id ASC
              LIMIT ? OFFSET ?`,
          )
          .all(...params, pageSize, (page - 1) * pageSize) as Array<{
          pack_id: string;
          author_id: string;
          nickname: string;
          release_id: string;
          release_number: number;
          title: string;
          purpose: string;
          submitted_at: number;
          item_count: number;
          favorite_count: number;
        }>;

        return buildPage(
          rows.map((r) => ({
            packId: r.pack_id,
            authorNickname: r.nickname,
            title: r.title,
            purpose: r.purpose,
            releaseNumber: Number(r.release_number),
            releaseId: r.release_id,
            pluginCount: Number(r.item_count),
            favoriteCount: Number(r.favorite_count),
            publishedAt: r.submitted_at,
          })),
          total,
          { page, page_size: pageSize },
        );
      }, injectedDb ?? db);
    },

    /** 我的整合包：按包展示，带最近版本与其状态（§26 个人中心）。 */
    async listMyPacks(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<PackSummaryView[]> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (
                 PARTITION BY rel.pack_id ORDER BY rel.submitted_at DESC, rel.id DESC
               ) AS rn
                 FROM plugin_pack_releases rel
             )
             SELECT p.id AS pack_id, p.author_id, u.nickname, l.id AS release_id, l.release_number,
                    l.review_status, l.review_note, l.title, l.purpose, l.submitted_at,
                    (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = l.id) AS item_count,
                    (SELECT COUNT(*) FROM plugin_pack_favorites f WHERE f.pack_id = p.id) AS favorite_count,
                    ce.withdrawn_at, ce.hidden_at
               FROM plugin_packs p
               JOIN latest l ON l.pack_id = p.id AND l.rn = 1
               JOIN content_entities ce ON ce.id = l.id
               JOIN users u ON u.id = p.author_id
              WHERE p.author_id = ?
              ORDER BY p.created_at DESC, p.id ASC`,
          )
          .all(userId) as Array<{
          pack_id: string;
          author_id: string;
          nickname: string;
          release_id: string;
          release_number: number | null;
          review_status: 'draft' | 'pending' | 'published' | 'rejected';
          review_note: string | null;
          title: string;
          purpose: string;
          submitted_at: number;
          item_count: number;
          favorite_count: number;
          withdrawn_at: number | null;
          hidden_at: number | null;
        }>;
        return rows.map((r) => ({
          packId: r.pack_id,
          authorNickname: r.nickname,
          title: r.title,
          purpose: r.purpose,
          releaseNumber: r.release_number === null ? null : Number(r.release_number),
          releaseId: r.release_id,
          pluginCount: Number(r.item_count),
          favoriteCount: Number(r.favorite_count),
          publishedAt: r.submitted_at,
          reviewStatus: r.review_status,
          reviewNote: r.review_note,
          // 作者要看得到"这个版本当前是否还公开"
          withdrawn: r.withdrawn_at !== null,
          hidden: r.hidden_at !== null,
        }));
      }, injectedDb ?? db);
    },

    /**
     * 详情：默认取最近**仍公开**的版本；指定版本不公开时如实返回状态，
     * 不悄悄换成别的版本（§88.2）。
     */
    async getPack(
      ctx: CallerContext,
      packId: string,
      options: { releaseNumber?: number } = {},
      injectedDb?: SqliteDatabase,
    ): Promise<PackDetailView> {
      return withRead((conn) => {
        const pack = conn
          .prepare(
            `SELECT p.id, p.author_id, u.nickname FROM plugin_packs p
               JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
          )
          .get(packId) as { id: string; author_id: string; nickname: string } | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');

        const releaseRows = conn
          .prepare(
            `SELECT rel.id, rel.release_number, rel.title, rel.submitted_at, ce.withdrawn_at, ce.hidden_at
               FROM plugin_pack_releases rel JOIN content_entities ce ON ce.id = rel.id
              WHERE rel.pack_id = ? AND rel.release_number IS NOT NULL AND rel.review_status = 'published'
              ORDER BY rel.release_number DESC`,
          )
          .all(packId) as Array<{
          id: string;
          release_number: number;
          title: string;
          submitted_at: number;
          withdrawn_at: number | null;
          hidden_at: number | null;
        }>;

        const releases: PackReleaseSummary[] = releaseRows.map((r) => ({
          releaseId: r.id,
          releaseNumber: Number(r.release_number),
          title: r.title,
          submittedAt: r.submitted_at,
          withdrawn: r.withdrawn_at !== null,
          hidden: r.hidden_at !== null,
        }));

        const isAuthor = ctx.userId !== null && ctx.userId === pack.author_id;
        const anyAdmin = isAdmin(ctx);

        let target: ReleaseRow | undefined;
        let requestedUnavailable = false;
        if (options.releaseNumber !== undefined) {
          const found = releaseRows.find((r) => Number(r.release_number) === options.releaseNumber);
          if (found) target = readReleaseRow(conn, found.id);
          requestedUnavailable = target !== undefined && !isPublicRelease(target);
        }
        if (target === undefined) {
          for (const row of releaseRows) {
            const full = readReleaseRow(conn, row.id);
            if (full && isPublicRelease(full)) {
              target = full;
              break;
            }
          }
        }

        const favoriteCount = (conn
          .prepare('SELECT COUNT(*) AS c FROM plugin_pack_favorites WHERE pack_id = ?')
          .get(packId) as { c: number }).c;
        const favoritedByMe =
          ctx.userId === null
            ? false
            : conn.prepare('SELECT 1 AS x FROM plugin_pack_favorites WHERE pack_id = ? AND user_id = ?').get(packId, ctx.userId) !==
              undefined;

        let selected: PackReleaseDetail | null = null;
        if (target) {
          // 非作者、非管理员看不到已撤回/隐藏版本的内容（但看得到"该版本已撤回"的状态）
          const visible = isPublicRelease(target) || isAuthor || anyAdmin;
          if (visible) {
            const itemRows = conn
              .prepare(
                `SELECT i.id, i.plugin_id, i.position, i.purpose, i.display_snapshot, i.plugin_version,
                        i.install_target, i.source_url, p.plugin_path, r.full_name
                   FROM plugin_pack_release_items i
                   LEFT JOIN plugins p ON p.id = i.plugin_id
                   LEFT JOIN repositories r ON r.id = p.repository_id
                  WHERE i.release_id = ? ORDER BY i.position ASC`,
              )
              .all(target.id) as Array<{
              id: string;
              plugin_id: string;
              position: number;
              purpose: string | null;
              display_snapshot: string;
              plugin_version: string;
              install_target: string | null;
              source_url: string | null;
              plugin_path: string | null;
              full_name: string | null;
            }>;
            const items: PackItemView[] = itemRows.map((row) => toItemView(row));
            const commands = buildInstallCommands(
              items.map((i) => ({
                pluginId: i.pluginId,
                displayName: i.displayName,
                pluginVersion: i.pluginVersion,
                installTarget: i.installTarget,
                sourceUrl: i.sourceUrl ?? null,
              })),
            );
            selected = {
              releaseId: target.id,
              releaseNumber: Number(target.release_number),
              title: target.title,
              purpose: target.purpose,
              bodyMarkdown: target.body_markdown,
              dshVersion: JSON.parse(target.dsh_version) as VersionValue,
              configTemplate: target.config_template,
              testStatus: target.test_status,
              testTask: target.test_task,
              testResult: target.test_result,
              publishedAt: target.submitted_at,
              withdrawn: target.withdrawn_at !== null,
              hidden: target.hidden_at !== null,
              items,
              commands,
            };
          }
        }

        return {
          packId: pack.id,
          authorId: pack.author_id,
          authorNickname: pack.nickname,
          favoriteCount: Number(favoriteCount),
          favoritedByMe,
          releases,
          selected,
          requestedUnavailable,
          fellBack:
            options.releaseNumber === undefined &&
            releases.length > 0 &&
            selected !== null &&
            Number(selected.releaseNumber) !== Number(releases[0]!.releaseNumber),
        };
      }, injectedDb ?? db);
    },

    /** 收藏切换（关联包本身；没有公开版本的包不允许收藏）。 */
    async togglePackFavorite(
      ctx: CallerContext,
      packId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ favorited: boolean }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const exists = conn.prepare('SELECT 1 AS x FROM plugin_packs WHERE id = ?').get(packId);
        if (!exists) throw err.unavailable('整合包不存在。');
        const publicCount = (conn
          .prepare(
            `SELECT COUNT(*) AS c FROM plugin_pack_releases rel
               JOIN content_entities ce ON ce.id = rel.id
              WHERE rel.pack_id = ? AND rel.release_number IS NOT NULL AND rel.review_status = 'published'
                AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL`,
          )
          .get(packId) as { c: number }).c;
        if (Number(publicCount) === 0) throw err.unavailable('这个整合包当前没有公开版本，无法收藏。');

        const current = conn
          .prepare('SELECT 1 AS x FROM plugin_pack_favorites WHERE pack_id = ? AND user_id = ?')
          .get(packId, userId);
        if (current) {
          conn.prepare('DELETE FROM plugin_pack_favorites WHERE pack_id = ? AND user_id = ?').run(packId, userId);
          return { favorited: false };
        }
        conn
          .prepare('INSERT INTO plugin_pack_favorites (user_id, pack_id, created_at) VALUES (?, ?, ?)')
          .run(userId, packId, nowMs());
        return { favorited: true };
      }, injectedDb ?? db);
    },

    /** 我收藏的整合包（详情页/个人中心）。 */
    async listFavoritePacks(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<PackSummaryView[]> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (PARTITION BY rel.pack_id ORDER BY rel.release_number DESC) AS rn
                 FROM plugin_pack_releases rel
                 JOIN content_entities ce ON ce.id = rel.id
                WHERE rel.release_number IS NOT NULL AND rel.review_status = 'published'
                   AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL
             )
             SELECT p.id AS pack_id, u.nickname, l.id AS release_id, l.release_number, l.title, l.purpose,
                    l.submitted_at,
                    (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = l.id) AS item_count,
                    (SELECT COUNT(*) FROM plugin_pack_favorites f2 WHERE f2.pack_id = p.id) AS favorite_count
               FROM plugin_pack_favorites f
               JOIN plugin_packs p ON p.id = f.pack_id
               JOIN latest l ON l.pack_id = p.id AND l.rn = 1
               JOIN users u ON u.id = p.author_id
              WHERE f.user_id = ?
              ORDER BY f.created_at DESC, p.id ASC`,
          )
          .all(userId) as Array<{
          pack_id: string;
          nickname: string;
          release_id: string;
          release_number: number;
          title: string;
          purpose: string;
          submitted_at: number;
          item_count: number;
          favorite_count: number;
        }>;
        return rows.map((r) => ({
          packId: r.pack_id,
          authorNickname: r.nickname,
          title: r.title,
          purpose: r.purpose,
          releaseNumber: Number(r.release_number),
          releaseId: r.release_id,
          pluginCount: Number(r.item_count),
          favoriteCount: Number(r.favorite_count),
          publishedAt: r.submitted_at,
        }));
      }, injectedDb ?? db);
    },
  };
}

export type PacksService = ReturnType<typeof createPacksService>;

export function packsService(): PacksService {
  return createPacksService({ db: getDb() });
}
