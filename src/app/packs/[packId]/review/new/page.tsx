/** 写整合包测评（默认针对当前公开版本，可用 ?v= 指定版本）。 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { currentContext } from '../../../../api/_lib/context';
import { CreatePackReviewForm } from '@/components/create-pack-review-form';

export const dynamic = 'force-dynamic';

function first(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const raw = sp[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function NewPackReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ packId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { packId } = await params;
  const sp = await searchParams;
  const ctx = await currentContext();
  if (ctx.userId === null) redirect(`/onboarding?returnTo=/packs/${packId}/review/new`);

  const vRaw = first(sp, 'v');
  const releaseNumber = vRaw === undefined ? undefined : Number.parseInt(vRaw, 10);
  let detail;
  try {
    detail = await createPacksService({ db: getDb() }).getPack(ctx, packId, {
      releaseNumber:
        releaseNumber !== undefined && Number.isFinite(releaseNumber) && releaseNumber > 0
          ? releaseNumber
          : undefined,
    });
  } catch {
    notFound();
  }
  if (!detail.selected) {
    return (
      <div>
        <h1>写整合包测评</h1>
        <p className="empty">这个整合包当前没有可公开的版本，无法测评。</p>
        <p>
          <Link href={`/packs/${packId}`}>返回整合包</Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1>写整合包测评</h1>
      <p style={{ marginTop: 0 }}>
        <Link href={`/packs/${packId}?v=${detail.selected.releaseNumber}`}>← 返回整合包</Link>
      </p>
      <CreatePackReviewForm
        releaseId={detail.selected.releaseId}
        packTitle={detail.selected.title}
        releaseNumber={detail.selected.releaseNumber}
      />
    </div>
  );
}
