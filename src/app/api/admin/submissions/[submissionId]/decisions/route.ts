/**
 * 管理员人工审核决定（架构第 90.2 节）。
 *
 * POST /api/admin/submissions/{submissionId}/decisions
 *
 * 通过仍须满足结构、附件及类型发布条件；实际发布由发布流程另行核验资格。
 *
 * ⚠️ 「通过」会**同时入队一条 `review_publish` 任务**（走 `workflows/decide-submission`）——
 * 否则状态改成 approved 之后没有任何东西会去发布，人工审核这条路径是断的。
 * 返回值里的 `publishQueued` 如实报告入队是否成功，后台页面必须把它显示出来。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { decideSubmission } from '@/server/workflows/decide-submission';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { submissionId } = await params;
    const body = (await readJson(request)) as {
      decision?: unknown;
      reason?: unknown;
      expectedStateVersion?: unknown;
      requestKey?: unknown;
    };

    if (body.decision !== 'approve' && body.decision !== 'needs_changes') {
      throw err.input('决定只能是通过或需修改。', [{ path: 'decision', message: '取值不合法' }]);
    }
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw err.input('必须填写处理原因。', [{ path: 'reason', message: '必填' }]);
    }
    if (!Number.isInteger(body.expectedStateVersion)) {
      throw err.input('缺少预期提交版本。', [{ path: 'expectedStateVersion', message: '必须是整数' }]);
    }
    if (typeof body.requestKey !== 'string' || body.requestKey.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }

    // 通过时**同时**入队发布任务（workflows/decide-submission）。
    // 只改状态不入队的话，人工通过之后没有任何东西会去发布 —— 曾真的这样。
    const result = await decideSubmission(
      ctx,
      {
        submissionId,
        decision: body.decision,
        reason: body.reason,
        expectedStateVersion: body.expectedStateVersion as number,
        requestKey: body.requestKey,
      },
      getDb(),
    );

    return okJson(
      {
        state: result.state,
        publishTaskId: result.publishTaskId,
        // 通过但没能入队 = 需要人管：调用方（后台页面）必须如实提示。
        publishQueued: result.publishTaskId !== null,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
