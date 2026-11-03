/**
 * 讨论区首页：分区列表 + 各分区入口。
 *
 * 匿名可看分区（它们本来就公开），但发帖按钮对未登录用户改为跳登录。
 * 开关关闭时整页 404，与接口同口径。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumBoardService } from '@/server/modules/forum/boards';
import { POSTING_POLICY_LABELS, BOARD_STATUS_LABELS } from '@/packages/common/forum';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function ForumPage() {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const ctx = await currentContext();
  const boards = await createForumBoardService({ db }).listBoards(ctx);

  return (
    <div>
      <h1>讨论区</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        聊插件、评测与整合包之外的一切。发帖需要登录；各分区的发帖权限由分区自行管理。
      </p>

      {boards.length === 0 ? (
        <p className="empty">还没有分区。</p>
      ) : (
        <ul className="item-list">
          {boards.map((board) => (
            <li key={board.boardId} className="item">
              <div className="item-body">
                <h3>
                  <Link href={'/forum/' + board.slug}>{board.name}</Link>
                  {board.isOfficial ? (
                    <span className="tag site" style={{ marginLeft: 8 }}>
                      官方
                    </span>
                  ) : null}
                  {board.status === 'archived' ? (
                    <span className="tag" style={{ marginLeft: 8 }}>
                      {BOARD_STATUS_LABELS.archived}
                    </span>
                  ) : null}
                </h3>
                <div className="list-meta">
                  {board.description ? <span className="truncate">{board.description}</span> : null}
                  <span>{POSTING_POLICY_LABELS[board.postingPolicy]}</span>
                  <span>创建于 {formatDateTimeOr(board.createdAt, '未知')}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>
        <Link href="/forum/applications">申请新建分区</Link>
      </p>
    </div>
  );
}
