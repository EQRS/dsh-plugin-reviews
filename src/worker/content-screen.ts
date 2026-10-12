/**
 * 本地基础内容筛查（工作包 GT / task-6）。
 *
 * ⚠️ 这不是真实的第三方审核服务。
 *
 * 背景与理由（Lead 裁决 2026-10-11）：
 *  - `moderation.runRuleCheck` 只有在注入的 `contentScreen` 返回 `'pass'` 时才转 `approved`；
 *    未注入 → `not_configured` → `manual_review`。这是**正确的保守默认**（架构第 56 节：
 *    外部检查未配置绝不自动放行）。
 *  - 但演示/开发时需要一条能走通"提交 → 自动发布"的路径，否则链路永远停在人工复核。
 *  - 因此本文件提供一个**本地、确定性、可解释**的基础筛查，由环境变量显式开启：
 *
 * ```
 * DSH_REVIEW_CONTENT_SCREEN 未设置（默认） → 不启用（保持保守，落 manual_review）
 * DSH_REVIEW_CONTENT_SCREEN=basic          → 启用本地基础筛查
 * ```
 *
 * **生产部署必须替换成真实内容审核供应商**（适配器位于 `src/server/adapters/`）。
 * 本筛查只挡最明显的垃圾内容（空/过短正文、重复字符刷屏、命中基础违禁词表），
 * 不做语义判断，也不应被当作安全边界。
 */

import type { SqliteDatabase } from '@/server/platform/db';

/** 正文长度下限（字符）：短于此视为无实质内容。 */
export const MIN_BODY_LENGTH = 20;

/**
 * 基础违禁词表（**演示用占位**，故意保持极短且不含真实敏感词）。
 * 真实部署应由供应商词库或人工规则替代。
 */
export const BASIC_BLOCKLIST: readonly string[] = [
  'buy-cheap-followers',
  'free-crypto-giveaway',
  'viagra-online',
];

export type ScreenDecision = 'pass' | 'violation' | 'inconclusive';

export interface ScreenInput {
  submissionId: string;
  /** 提交的快照视图（评测修订或评论修订）。 */
  snapshot: unknown;
}

/** 本地筛查的判定结果，附带可解释依据（写进 content_moderation_records.evidence）。 */
export interface ScreenVerdict {
  decision: ScreenDecision;
  reason: string;
  /** 触发判定的字段路径，便于前端定位。 */
  fields: string[];
}

interface SnapshotShape {
  submissionType?: 'review_revision' | 'comment_revision';
  title?: string | null;
  body?: string | null;
  bodyMarkdown?: string | null;
}

function extractText(snapshot: unknown): { title: string; body: string } {
  const s = (snapshot ?? {}) as SnapshotShape;
  return {
    title: typeof s.title === 'string' ? s.title : '',
    body: typeof s.body === 'string' ? s.body : typeof s.bodyMarkdown === 'string' ? s.bodyMarkdown : '',
  };
}

/**
 * 纯函数判定：不碰数据库，便于直接单测。
 *
 * 判定顺序（任一命中即返回，理由可解释）：
 *  1. 正文为空 → violation（无实质内容）
 *  2. 正文短于下限 → violation
 *  3. 命中基础违禁词 → violation
 *  4. 重复字符刷屏（同一字符占比过高）→ violation
 *  5. 否则 pass
 */
export function evaluateBasicScreen(snapshot: unknown): ScreenVerdict {
  const { title, body } = extractText(snapshot);
  const text = `${title}\n${body}`.trim();

  if (body.trim() === '') {
    return { decision: 'violation', reason: '正文为空，没有可发布的内容。', fields: ['body'] };
  }

  if (body.trim().length < MIN_BODY_LENGTH) {
    return {
      decision: 'violation',
      reason: `正文过短（少于 ${MIN_BODY_LENGTH} 字），疑似无实质内容。`,
      fields: ['body'],
    };
  }

  const lowered = text.toLowerCase();
  for (const word of BASIC_BLOCKLIST) {
    if (lowered.includes(word.toLowerCase())) {
      return {
        decision: 'violation',
        reason: '命中基础违禁词表（演示用占位词表，非真实审核）。',
        fields: ['body'],
      };
    }
  }

  // 重复字符刷屏：单一字符占比超过 70% 且长度足够，判定为垃圾。
  const compact = body.replace(/\s/g, '');
  if (compact.length >= MIN_BODY_LENGTH) {
    const counts = new Map<string, number>();
    for (const ch of compact) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const max = Math.max(...counts.values());
    if (max / compact.length > 0.7) {
      return { decision: 'violation', reason: '正文疑似重复字符刷屏。', fields: ['body'] };
    }
  }

  return { decision: 'pass', reason: '通过本地基础筛查。', fields: [] };
}

/**
 * 读取环境变量：只有显式设为 `basic` 才启用。其他值一律视为未启用（保守）。
 *
 * 参数类型刻意用 `Record<string, string | undefined>` 而不是 `NodeJS.ProcessEnv`：
 * 后者在当前 TS 配置下要求 `NODE_ENV` 必填，测试里传字面量环境对象会被判类型错误。
 * 这里只需要"能按 key 取值"，用最小结构即可。
 */
export function basicScreenEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DSH_REVIEW_CONTENT_SCREEN === 'basic';
}

/** 供 `createModerationService` 注入的适配器形状。 */
export type ContentScreenFn = (input: ScreenInput) => Promise<'pass' | 'violation' | 'inconclusive'>;

/**
 * 构造注入用的筛查函数。
 *
 * ⚠️ **必须自己按 submissionId 读正文**，不能用 moderation 传进来的 `snapshot`：
 * `moderation.runRuleCheck` 内的 `loadSnapshot` 只取 `title/pluginId/pluginVersion/dshVersion`
 * （那是**字段校验**用的视图，刻意不含正文），因此注入的 screen 收到的 snapshot
 * 没有 body —— 直接拿它判定会把一切内容都当成"空正文"误判违规。
 *
 * 判定依据因此从库里现读：评测取 `review_revisions.body_markdown`，评论取 `comment_revisions.body`。
 * `input.snapshot` 仍然可用（若调用方自己传了带正文的视图，则优先用它）。
 */
export function createBasicContentScreen(db?: SqliteDatabase): ContentScreenFn {
  return async (input: ScreenInput) => {
    // 优先用调用方给的 snapshot（若有正文）；否则自行按 submissionId 读库。
    const fromSnapshot = hasBody(input.snapshot);
    const view = fromSnapshot
      ? input.snapshot
      : db
        ? loadSnapshotForScreen(db, input.submissionId)
        : null;
    return evaluateBasicScreen(view).decision;
  };
}

/** snapshot 是否已经带上了可判定的正文。 */
function hasBody(snapshot: unknown): boolean {
  const s = (snapshot ?? {}) as SnapshotShape;
  const body = typeof s.body === 'string' ? s.body : typeof s.bodyMarkdown === 'string' ? s.bodyMarkdown : '';
  return body.trim() !== '';
}

/**
 * 从库里读取提交对应的快照视图。
 *
 * 评测修订取 title/body_markdown；评论修订取 body。与 moderation 服务内部的
 * `loadSnapshot` 保持同一形状（submissionType/title/bodyMarkdown），避免两处漂移。
 */
export function loadSnapshotForScreen(db: SqliteDatabase, submissionId: string): unknown {
  const row = db
    .prepare('SELECT submission_type, review_revision_id, comment_revision_id FROM content_submissions WHERE id = ?')
    .get(submissionId) as
    | {
        submission_type: 'review_revision' | 'comment_revision';
        review_revision_id: string | null;
        comment_revision_id: string | null;
      }
    | undefined;
  if (!row) return null;

  if (row.submission_type === 'review_revision' && row.review_revision_id) {
    const rev = db
      .prepare('SELECT title, body_markdown FROM review_revisions WHERE id = ?')
      .get(row.review_revision_id) as { title: string; body_markdown: string } | undefined;
    if (!rev) return null;
    return { submissionType: 'review_revision', title: rev.title, bodyMarkdown: rev.body_markdown };
  }

  if (row.submission_type === 'comment_revision' && row.comment_revision_id) {
    const rev = db
      .prepare('SELECT body FROM comment_revisions WHERE id = ?')
      .get(row.comment_revision_id) as { body: string } | undefined;
    if (!rev) return null;
    return { submissionType: 'comment_revision', body: rev.body };
  }

  return null;
}
