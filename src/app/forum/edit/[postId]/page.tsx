/**
 * 编辑帖子：/forum/edit/{postId}
 *
 * 只给作者与管理员看；服务端会再校验一次（不能因为前端藏了按钮就认为安全）。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { isAuthenticated } from '@/server/platform/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumPostService } from '@/server/modules/forum/posts';
import { DomainError, ErrorCodes } from '@/packages/common/errors';
import { ForumPostEditForm } from '@/components/forum-post-edit-form';

export const dynamic = 'force-dynamic';

export default async function EditForumPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const { postId } = await params;
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=' + encodeURIComponent('/forum/edit/' + postId));

  let post;
  try {
    post = await createForumPostService({ db }).getPost(ctx, postId);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }
  if (!post.canEdit) notFound();

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href={'/forum/' + post.boardSlug + '/' + post.postId}>← 返回帖子</Link>
      </p>
      <h1>编辑帖子</h1>
      <ForumPostEditForm
        postId={post.postId}
        initialTitle={post.title}
        initialBody={post.bodyMd}
        returnHref={'/forum/' + post.boardSlug + '/' + post.postId}
      />
    </div>
  );
}
