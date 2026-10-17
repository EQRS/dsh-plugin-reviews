/**
 * 评测草稿编辑器页（任务 7 第 3 项）。
 *
 * 服务端只校验"是否登录"，草稿归属与内容由客户端向 API 取
 * （GET /api/drafts 会按所有权拒绝，服务端不再重复实现一遍判断）。
 */

import { currentContext } from '@/app/api/_lib/context';
import { BackLink } from '@/components/back-link';
import { ReviewEditor } from '@/components/review-editor';

export const dynamic = 'force-dynamic';

export default async function DraftEditorPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const ctx = await currentContext();

  if (ctx.userId === null) {
    return (
      <div>
        <BackLink href="/me">返回我的评测</BackLink>
        <h1 style={{ fontSize: 22 }}>需要登录</h1>
        <p className="muted">编辑草稿需要登录。请使用页面顶部的登录入口。</p>
      </div>
    );
  }

  return <ReviewEditor draftId={draftId} />;
}
