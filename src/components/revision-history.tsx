'use client';

/**
 * 修订历史（需求第 10 节：作者与管理员可查完整修订）。
 *
 * 契约（见 src/app/api/reviews/[reviewId]/revisions/route.ts）：
 *   GET /api/reviews/{reviewId}/revisions → { canReadBodies, currentPublishedRevisionId, revisions[] }
 *
 * 三条硬规则（都在服务端执行，本组件只是如实呈现）：
 *  1. **公开访客只拿到元信息**：提交时间与公开状态；标题/正文只在「作者本人或管理员」的响应里出现，
 *     所以这里的展开按钮也只在 `canReadBodies` 为真时渲染 —— 这只是"不摆一个点了也没用的入口"，
 *     不是权限判断（前端隐藏挡不住直连接口）。
 *  2. **快照不可改写**：历史上传过的正文永远可回看，但没有任何编辑/回滚入口；
 *     正文按需展开，首次进入不整篇拉取。
 *  3. 时间一律用 `formatDateTime`（钉死 Asia/Shanghai），不写 `new Date().toLocaleString()`
 *     —— 线上 VPS 是 UTC，那样会整体偏 8 小时。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { formatDateTime } from '@/packages/common/time';

/** 与接口的 `RevisionStatus` 一一对应：只表达读者能观察到的事实，不含审核阶段。 */
type RevisionStatus = 'current' | 'superseded' | 'unpublished';

interface RevisionItem {
  revisionId: string;
  revisionNumber: number;
  submittedAt: string;
  status: RevisionStatus;
  isCurrentPublished: boolean;
  wasPublished: boolean;
  isSuperseded: boolean;
  isWithdrawn: boolean;
  publiclyAvailable: boolean;
  /** 以下三项只在 `canReadBodies` 为 true 时由服务端下发。 */
  title?: string;
  bodyMarkdown?: string;
  bodyHtml?: string;
}

interface RevisionListData {
  reviewId: string;
  currentPublishedRevisionId: string | null;
  canReadBodies: boolean;
  publiclyVisible: boolean;
  withdrawn: boolean;
  hidden: boolean;
  total: number;
  revisions: RevisionItem[];
}

/** 状态文案与标签样式集中在这里，避免同一状态在两处各写一套、慢慢漂移。 */
function statusTag(revision: RevisionItem): { label: string; className: string } {
  if (revision.isCurrentPublished) {
    return revision.isWithdrawn
      ? { label: '当前公开修订（文章已撤回）', className: 'tag danger' }
      : { label: '当前公开修订', className: 'tag site' };
  }
  if (revision.isSuperseded) {
    return { label: '已被更新的修订取代', className: 'tag' };
  }
  return { label: '未公开', className: 'tag warn' };
}

/** 提交时间：ISO 解析失败时如实说"时间未知"，不显示 NaN。 */
function submittedLabel(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatDateTime(ms) : '时间未知';
}

export function RevisionHistory({ reviewId }: { reviewId: string }) {
  const [data, setData] = useState<RevisionListData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // 展开状态按修订 id 记录：默认全收起（历史正文按需读取，不整页铺开）。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setData(
        await apiFetch<RevisionListData>(`/api/reviews/${encodeURIComponent(reviewId)}/revisions`, {
          cache: 'no-store',
        }),
      );
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [reviewId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 文章在读取过程中被撤回/隐藏：接口返回 target_unavailable。这不是"操作失败"，
  // 也不该显示成用户做错了什么 —— 如实说明"当前不可查看"即可。
  const unavailable = error !== null && error.code === 'target_unavailable';

  return (
    <section
      aria-labelledby={`revision-history-heading-${reviewId}`}
      style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 16 }}
    >
      <div className="section-head" style={{ marginBottom: 8 }}>
        <h2 id={`revision-history-heading-${reviewId}`} style={{ fontSize: 18 }}>
          修订历史{data === null ? '' : `（${data.total}）`}
        </h2>
      </div>

      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        每次提交都会生成一份不可改写的快照，历史不会被覆盖。
        {data !== null && !data.canReadBodies ? ' 仅作者与管理员可查看历史正文。' : ''}
      </p>

      {unavailable ? (
        <p className="muted">该评测当前不可查看，修订历史不可用。</p>
      ) : error ? (
        <ErrorNotice error={error} onDismiss={() => setError(null)} />
      ) : null}

      {data === null && error === null ? <p className="muted">正在读取修订历史…</p> : null}

      {data !== null && data.revisions.length === 0 ? <p className="muted">还没有修订记录。</p> : null}

      {data !== null && data.revisions.length > 0 ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {data.revisions.map((revision) => {
            const tag = statusTag(revision);
            const canExpand = data.canReadBodies && typeof revision.bodyHtml === 'string';
            const isOpen = canExpand && expanded[revision.revisionId] === true;
            const bodyId = `revision-body-${reviewId}-${revision.revisionId}`;
            return (
              <li
                key={revision.revisionId}
                style={{
                  position: 'relative',
                  paddingLeft: 18,
                  paddingBottom: 14,
                  borderLeft: '2px solid var(--line)',
                }}
              >
                {/* 时间线圆点：当前公开修订用强调色，其余用弱化描边（颜色不是唯一区分手段，
                    状态同时用文字标签给出）。 */}
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: -6,
                    top: 6,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: revision.isCurrentPublished ? 'var(--accent)' : 'var(--line-strong)',
                  }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>第 {revision.revisionNumber} 次提交</strong>
                  <span className="tag">{submittedLabel(revision.submittedAt)}</span>
                  <span className={tag.className}>{tag.label}</span>
                </div>

                {canExpand ? (
                  <>
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="link-btn"
                        aria-expanded={isOpen}
                        aria-controls={bodyId}
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [revision.revisionId]: !isOpen }))
                        }
                      >
                        {isOpen ? '收起正文' : '展开正文'}
                      </button>
                    </div>
                    <div id={bodyId} hidden={!isOpen}>
                      {isOpen ? (
                        <div style={{ marginTop: 8 }}>
                          {revision.title ? (
                            <h3 style={{ fontSize: 15, marginBottom: 6 }}>{revision.title}</h3>
                          ) : null}
                          {/*
                            经 rehype-sanitize 净化后的 HTML（服务端统一管线，与文章正文同一套）；
                            Markdown 原文才是权威内容，这里只用于展示。
                          */}
                          <div
                            className="review-body"
                            style={{ fontSize: 15, lineHeight: 1.7 }}
                            dangerouslySetInnerHTML={{ __html: revision.bodyHtml ?? '' }}
                          />
                          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                            历史修订中的图片按该修订当前的公开状态提供，旧版引用的图片可能已不可读取。
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}