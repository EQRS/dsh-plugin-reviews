/** 对整合包版本发表测评（当前直接发布）。 */
import { getDb } from '@/server/platform/db';
import { createPackReviewsService } from '@/server/modules/pack-reviews';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { releaseId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as {
      title?: unknown;
      bodyMarkdown?: unknown;
      dshVersion?: unknown;
      verdict?: unknown;
      assessmentLevel?: unknown;
      evidenceRefs?: unknown;
    };
    const service = createPackReviewsService({ db: getDb() });
    const result = await service.createPackReview(ctx, {
      releaseId,
      title: String(body.title ?? ''),
      bodyMarkdown: String(body.bodyMarkdown ?? ''),
      dshVersion: String(body.dshVersion ?? '{"kind":"unknown"}'),
      verdict: typeof body.verdict === 'string' ? body.verdict : null,
      assessmentLevel: typeof body.assessmentLevel === 'string' ? body.assessmentLevel : null,
      evidenceRefs: typeof body.evidenceRefs === 'string' ? body.evidenceRefs : null,
    });
    return okJson(result, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
