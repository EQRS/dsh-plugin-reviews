/** 后台：编辑一期精选专栏。 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { createFeaturedService } from '@/server/modules/featured';
import { readPreferences } from '@/server/modules/preferences';
import { FeaturedEditor } from '@/components/featured-editor';
import { DomainError, ErrorCodes } from '@/packages/common/errors';

export const dynamic = 'force-dynamic';

export default async function FeaturedEditPage({ params }: { params: Promise<{ issue: string }> }) {
  const { issue } = await params;
  const issueNumber = Number.parseInt(issue, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) notFound();

  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');
  const userId = ctx.userId as string;

  const db = getDb();
  const service = createFeaturedService({ db });
  let detail;
  try {
    detail = await service.getForEdit(ctx, issueNumber);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }

  return (
    <div>
      <div className="section-head">
        <h1 style={{ margin: 0 }}>编辑第 {issueNumber} 期</h1>
        <Link href="/admin/featured">← 返回精选管理</Link>
      </div>
      <FeaturedEditor
        initial={detail}
        initialAutosaveSeconds={readPreferences(db, userId).editorAutosaveSeconds}
      />
    </div>
  );
}
