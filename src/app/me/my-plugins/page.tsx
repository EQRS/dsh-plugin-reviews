/**
 * 我的插件：查看已归属给自己的插件，以及发起认领。
 *
 * 这是「开发者」身份的前提页——身份体系的门槛是「至少一个本人插件」，
 * 而 plugins 表本身没有作者字段，归属关系要在这里认领建立。
 *
 * 三种状态都要能看到：
 *   * verified —— 已在名下（GitHub 账号匹配的自动通过，或认领审核通过）
 *   * pending  —— 认领审核中，给出去向说明，不要让人以为没提交成功
 *   * rejected —— 被驳回，**必须显示管理员给的理由**，否则用户不知道该怎么补
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../api/_lib/context';
import { getDb } from '@/server/platform/db';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import { MeNav } from '@/components/me-nav';
import { ClaimPluginForm } from '@/components/claim-plugin-form';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  verified: '已认领',
  pending: '审核中',
  rejected: '已驳回',
};

export default async function MyPluginsPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/my-plugins');

  const service = createPluginOwnershipService({ db: getDb() });
  const plugins = await service.listMine(ctx);

  const verified = plugins.filter((p) => p.ownershipStatus === 'verified');
  const others = plugins.filter((p) => p.ownershipStatus !== 'verified');

  return (
    <div>
      <h1>我的插件</h1>
      <div className="me-layout">
        <MeNav current="my-plugins" />
        <div>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            插件若能对上你的 GitHub 账号（你登录用的那个），会自动归到你名下；
            仓库属于组织的，需要在这里发起认领，由管理员核实。
            <br />
            至少有一个已认领的插件，才能申请「开发者」身份。
          </p>

          <ClaimPluginForm />

          {verified.length === 0 && others.length === 0 ? (
            <section className="panel">
              <p className="empty" style={{ marginBottom: 0 }}>
                还没有归属到你的插件。先到<Link href="/plugins">插件目录</Link>找到自己的插件，再回到这里认领。
              </p>
            </section>
          ) : null}

          {verified.length > 0 ? (
            <section className="panel" aria-label="已认领的插件">
              <div className="section-head">
                <h2>已认领（{verified.length}）</h2>
              </div>
              <ul className="item-list">
                {verified.map((p) => (
                  <li key={p.pluginId} className="item">
                    <div className="item-body">
                      <h3>
                        <Link href={`/plugins/${p.pluginId}`}>{p.displayName ?? p.repositoryFullName}</Link>
                        {p.pluginPath !== '.' ? <span className="muted"> · {p.pluginPath}</span> : null}
                        <span className="tag site" style={{ marginLeft: 8 }}>
                          {STATUS_LABELS[p.ownershipStatus]}
                        </span>
                        {p.ownershipSource === 'github_match' ? (
                          <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                            （GitHub 账号匹配，已自动通过）
                          </span>
                        ) : null}
                      </h3>
                      <div className="list-meta">
                        <span>{p.repositoryFullName}</span>
                        {p.isArchived ? <span className="tag warn">仓库已归档</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {others.length > 0 ? (
            <section className="panel" aria-label="待处理的认领">
              <div className="section-head">
                <h2>待处理（{others.length}）</h2>
              </div>
              <ul className="item-list">
                {others.map((p) => (
                  <li key={p.pluginId} className="item">
                    <div className="item-body">
                      <h3>
                        <Link href={`/plugins/${p.pluginId}`}>{p.displayName ?? p.repositoryFullName}</Link>
                        {p.pluginPath !== '.' ? <span className="muted"> · {p.pluginPath}</span> : null}
                        <span className="tag warn" style={{ marginLeft: 8 }}>
                          {STATUS_LABELS[p.ownershipStatus]}
                        </span>
                      </h3>
                      <div className="list-meta">
                        <span>{p.repositoryFullName}</span>
                        <span>提交于 {formatDateTime(p.createdAt)}</span>
                      </div>
                      {p.ownershipStatus === 'rejected' && p.reviewNote ? (
                        <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
                          驳回理由：{p.reviewNote}
                        </p>
                      ) : null}
                      {p.ownershipStatus === 'pending' ? (
                        <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
                          管理员审核中，通常几个工作日内处理。
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
