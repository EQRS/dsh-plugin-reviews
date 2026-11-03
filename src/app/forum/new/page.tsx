/**
 * 发帖页：/forum/new?board={slug}
 *
 * 分区从查询串带过来（从分区页点「发帖」进来时已经选好）；
 * 未登录先去登录，回来还能接着写。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { isAuthenticated } from '@/server/platform/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumBoardService } from '@/server/modules/forum/boards';
import { ForumPostForm } from '@/components/forum-post-form';

export const dynamic = 'force-dynamic';

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewForumPostPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const sp = await searchParams;
  const boardSlug = (firstValue(sp.board) ?? '').trim();

  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) {
    redirect('/onboarding?returnTo=' + encodeURIComponent('/forum/new?board=' + boardSlug));
  }

  const service = createForumBoardService({ db });
  const boards = await service.listBoards(ctx);
  const postable = boards.filter((b) => b.canPost);
  const selected = postable.find((b) => b.slug === boardSlug) ?? postable[0];

  if (!selected) {
    return (
      <div>
        <p style={{ marginTop: 0 }}>
          <Link href="/forum">← 返回讨论区</Link>
        </p>
        <h1>发帖</h1>
        <p className="empty">你当前没有可以发帖的分区。可以申请新建分区，或联系分区区长。</p>
      </div>
    );
  }

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href={'/forum/' + selected.slug}>← 返回「{selected.name}」</Link>
      </p>
      <h1>发帖</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        支持 Markdown，可以插入图片。发帖前请确认内容符合该分区的主题。
      </p>
      <ForumPostForm boards={postable.map((b) => ({ slug: b.slug, name: b.name }))} initialBoard={selected.slug} />
    </div>
  );
}
