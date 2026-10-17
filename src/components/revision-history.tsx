'use client';

/**
 * 修订历史：作者与管理员可查完整修订。
 *
 * 三条硬规则（都在服务端执行，本组件只是如实呈现）：
 *  1. 公开访客只拿到提交时间与公开状态；标题/正文只在作者本人或管理员的响应里出现，
 *     所以展开按钮也只在服务端允许读正文时渲染。
 *  2. 快照不可改写：历史上传过的正文永远可回看，但没有编辑/回滚入口。
 *  3. 时间一律按 Asia/Shanghai 格式化。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { formatDateTime } from '@/packages/common/time';
import { SkeletonLines } from './skeleton';

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

/** 状态文案与标签样式集中在这里，避免同一状态在两处各写一套。 */
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

/** 提交时间：解析失败时如实说"时间未知"，不显示 NaN。 */
function submittedLabel(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatDateTime(ms) : '时间未知';
}

export function RevisionHistory({ reviewId }: { reviewId: string }) {
  const [data, setData] = useState<RevisionListData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

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

  // 文章在读取过程中被撤回/隐藏：接口返回 target_unavailable。
  // 这不是"操作失败"，如实说明"当前不可查看"即可。
  const unavailable = error !== null && error.code === 'target_unavailable';

  return (
    <section className="panel" aria-labelledby={`revision-history-heading-${reviewId}`}>
      <div className="section-head">
        <h2 id={`revision-history-heading-${reviewId}`}>
          修订历史{data === null ? '' : `（${data.total}）`}
        </h2>
      </div>

      {unavailable ? (
        <p className="muted">该评测当前不可查看，修订历史不可用。</p>
      ) : error ? (
        <ErrorNotice error={error} onDismiss={() => setError(null)} />
      ) : null}

      {data === null && error === null ? <SkeletonLines lines={2} label="正在读取修订历史…" /> : null}

      {data !== null && data.revisions.length === 0 ? <p className="muted">还没有修订记录。</p> : null}

      {data !== null && data.revisions.length > 0 ? (
        <ol className="timeline">
          {data.revisions.map((revision) => {
            const tag = statusTag(revision);
            return (
              <li
                key={revision.revisionId}
                className={revision.isCurrentPublished ? 'timeline-item current' : 'timeline-item'}
              >
                {/* 时间线圆点：当前公开修订用主色 + 光晕（状态同时用文字标签给出，不靠颜色单独表意） */}
                <span className="timeline-dot" aria-hidden="true" />
                <span className="timeline-title">第 {revision.revisionNumber} 次提交</span>
                <span className="timeline-date">{submittedLabel(revision.submittedAt)}</span>
                <span className={tag.className}>{tag.label}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}