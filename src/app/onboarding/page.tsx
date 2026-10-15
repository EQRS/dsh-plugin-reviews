/**
 * 新用户落地页（架构第 11 节：新用户引导到资料确认页）。
 *
 * 为什么这个页面必须有：`api/auth/github/callback` 对新用户**就是** 302 到
 * `/onboarding?returnTo=...`，而在此之前项目里根本没有这个路由 ——
 * 真实 GitHub 新用户第一次登录会直接撞 404。
 * （一直没暴露，是因为真实 OAuth 往返从没跑过：需要主人的 Client Secret。）
 *
 * 本页只做三件事：告诉用户你是谁、确认展示昵称、然后回到原来要去的地方。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { ProfileForm } from '@/components/profile-form';

export const dynamic = 'force-dynamic';

interface Row {
  nickname: string;
  avatar_url: string | null;
  provider_username: string | null;
  profile_url: string | null;
}

/**
 * 只接受**站内**绝对路径。
 *
 * `returnTo` 来自查询串，直接 `router.push` 就是一个开放重定向
 * （`/onboarding?returnTo=https://evil.example` 或 `//evil.example` 都能把人带走）。
 */
export function safeReturnTo(raw: string | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  // `//host` 是协议相对 URL；`/\host` 在部分浏览器里等价 —— 两种都挡掉。
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const ctx = await currentContext();
  const returnTo = safeReturnTo((await searchParams).returnTo);

  if (ctx.userId === null) {
    return (
      <div>
        <h1>资料确认</h1>
        <p className="muted">
          需要先登录。这个页面是 GitHub 登录后给**新用户**做资料确认用的；
          未登录时请先从页面顶部登录。
        </p>
        <Link href="/">
          ← 返回首页
        </Link>
      </div>
    );
  }

  const row = getDb()
    .prepare(
      `SELECT u.nickname, u.avatar_url, ei.provider_username, ei.profile_url
         FROM users u
         LEFT JOIN external_identities ei ON ei.user_id = u.id AND ei.provider = 'github'
        WHERE u.id = ?`,
    )
    .get(ctx.userId) as Row | undefined;

  const nickname = row?.nickname ?? '';

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>欢迎来到 DSH 插件测评站</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        你是第一次来这里，先确认一下展示资料。
        {row?.provider_username ? (
          <>
            <br />
            本站通过 GitHub 识别你：
            {row.profile_url ? (
              <a href={row.profile_url}>
                {row.provider_username}
              </a>
            ) : (
              row.provider_username
            )}
          </>
        ) : null}
      </p>

      <div className="panel" style={{ marginTop: 16 }}>
        <ProfileForm initialNickname={nickname} returnTo={returnTo} />
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        这里可以收录插件、写评测、评论。收录不等于已实测可用；提交的内容要先通过检查才会公开。
      </p>

      <p style={{ marginTop: 16 }}>
        <Link href={returnTo} className="muted">
          ← 返回
        </Link>
      </p>
    </div>
  );
}