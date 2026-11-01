/**
 * 后台：精选专栏管理（含草稿）。
 *
 * 新建在下面表单里做；每行可进编辑页。「收藏夹页的创建按钮」也跳到这里（?new=1 只做锚点）。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { createFeaturedService } from '@/server/modules/featured';
import { FeaturedCreateForm } from '@/components/featured-create-form';
import { FeaturedDeleteButton } from '@/components/featured-delete-button';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function AdminFeaturedPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const sp = await searchParams;
  const service = createFeaturedService({ db: getDb() });
  const items = await service.listForAdmin(ctx);

  return (
    <div>
      <h1>精选专栏</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        每期一个主题 + 前言 + 一组插件（简述 / 推荐理由 / 百分制评分 / 测试集链接）。
        发布后读者可在 <Link href="/featured">/featured</Link> 看到。
      </p>

      <section className="panel" id="new" style={{ marginTop: 12 }}>
        <div className="section-head">
          <h2>新建一期</h2>
          {sp.new === '1' ? <span className="tag">从收藏夹入口进入</span> : null}
        </div>
        <FeaturedCreateForm />
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="section-head">
          <h2>全部期（{items.length}）</h2>
        </div>
        {items.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            还没有精选专栏。
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: 8 }}>期号</th>
                <th style={{ padding: 8 }}>标题</th>
                <th style={{ padding: 8 }}>状态</th>
                <th style={{ padding: 8 }}>插件</th>
                <th style={{ padding: 8 }}>更新时间</th>
                <th style={{ padding: 8 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.issueNumber} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: 8 }}>第 {row.issueNumber} 期</td>
                  <td style={{ padding: 8 }}>{row.title}</td>
                  <td style={{ padding: 8 }}>
                    {row.status === 'published' ? (
                      <span className="tag site">已发布</span>
                    ) : (
                      <span className="tag warn">草稿</span>
                    )}
                  </td>
                  <td style={{ padding: 8 }}>{row.itemCount}</td>
                  <td className="muted" style={{ padding: 8 }}>
                    {formatDateTimeOr(row.updatedAt, '未知')}
                  </td>
                  <td style={{ padding: 8 }}>
                    <Link href={'/admin/featured/' + row.issueNumber + '/edit'}>编辑</Link>
                    {row.status === 'published' ? (
                      <>
                        {' · '}
                        <Link href={'/featured/' + row.issueNumber}>查看</Link>
                      </>
                    ) : (
                      <>
                        {' · '}
                        <FeaturedDeleteButton issueNumber={row.issueNumber} />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p style={{ marginTop: 12 }}>
        <Link href="/admin">← 返回管理后台</Link>
      </p>
    </div>
  );
}
