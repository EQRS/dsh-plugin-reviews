/**
 * 我的帖子：已发布 / 已删除两个子页。
 *
 * 与评测那页的区别：讨论区没有「草稿」概念（发帖即公开），所以这里只有
 * 已发布与已删除；删除是软删，作者仍能看到自己删过什么。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { MeNav } from '@/components/me-nav';
import { createForumPostService } from '@/server/modules/forum/posts';
import { booleanSetting } from '@/server/modules/settings';
import { formatDateTimeOr } from '@/packages/common/time';
import type { ForumContentStatus } from '@/packages/common/forum';

export const dynamic = 'force-dynamic';

type Tab = 'published' | 'deleted';

const TAB_LABELS: Record<Tab, string> = {
  published: '已发布',
  deleted: '已删除',
};

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function readTab(raw: string | undefined): Tab {
  return raw === 'deleted' ? 'deleted' : 'published';
}

export default async function MePostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tab = readTab(firstValue(sp.tab));
  const rawPage = Number.parseInt(firstValue(sp.page) ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const ctx = await currentContext();
  const db = getDb();

  if (ctx.userId === null) {
    return (
      <div>
        <h1>我的帖子</h1>
        <div className="me-layout">
          <MeNav current="posts" />
          <div>
            <p className="muted" style={{ marginTop: 0 }}>
              需要先登录。请使用页面顶部的登录入口。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!booleanSetting(db, 'forum.enabled', true)) {
    return (
      <div>
        <h1>我的帖子</h1>
        <div className="me-layout">
          <MeNav current="posts" />
          <div>
            <p className="empty">讨论区暂未开放。</p>
          </div>
        </div>
      </div>
    );
  }

  const status: ForumContentStatus = tab === 'deleted' ? 'deleted' : 'published';
  const list = await createForumPostService({ db }).listMine(ctx, { page, status });

  return (
    <div>
      <h1>我的帖子</h1>
      <div className="me-layout">
        <MeNav current="posts" />
        <div>
          <div className="section-head" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['published', 'deleted'] as Tab[]).map((key) => (
                <Link
                  key={key}
                  href={'/me/posts' + (key === 'published' ? '' : '?tab=' + key)}
                  className={tab === key ? 'tag site' : 'tag'}
                >
                  {TAB_LABELS[key]}
                </Link>
              ))}
            </div>
            <Link href="/forum" className="button tonal">
              去讨论区
            </Link>
          </div>

          {list.items.length === 0 ? (
            <p className="empty">
              {tab === 'published'
                ? '还没有发布过帖子。去讨论区看看，或者直接发一个。'
                : '没有删除过的帖子。'}
            </p>
          ) : (
            <ul className="item-list">
              {list.items.map((post) => (
                <li key={post.postId} className="item">
                  <div className="item-body">
                    <h3 className="item-title">
                      <Link href={'/forum/' + post.boardSlug + '/' + post.postId}>{post.title}</Link>
                    </h3>
                    <div className="list-meta">
                      <span>{post.boardName}</span>
                      <span>{formatDateTimeOr(post.createdAt, '未知')}</span>
                      <span>{post.replyCount} 条回复</span>
                      <span>{post.likeCount} 赞</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {list.total_pages > 1 ? (
            <div className="pagination" style={{ marginTop: 16 }}>
              {page > 1 ? (
                <Link href={'/me/posts?tab=' + tab + '&page=' + (page - 1)}>上一页</Link>
              ) : null}
              <span className="muted">
                第 {page} / {list.total_pages} 页
              </span>
              {page < list.total_pages ? (
                <Link href={'/me/posts?tab=' + tab + '&page=' + (page + 1)}>下一页</Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
