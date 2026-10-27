/**
 * 新建整合包（发布第 1 版）。
 *
 * 服务端只负责把「用户的收藏夹 → 可勾选插件」喂给表单；
 * 版本/安装目标的填写与提交都在客户端（`pack-create-form`）。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../../api/_lib/context';
import { MeNav } from '@/components/me-nav';
import { PackCreateForm, type FolderOption } from '@/components/pack-create-form';

export const dynamic = 'force-dynamic';

export default async function NewPackPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/packs/new');

  const db = getDb();
  const folders = db
    .prepare(
      `SELECT f.id, f.name FROM favorite_folders f WHERE f.user_id = ? ORDER BY f.is_default DESC, f.created_at ASC`,
    )
    .all(ctx.userId) as Array<{ id: string; name: string }>;

  const options: FolderOption[] = folders.map((folder) => {
    const rows = db
      .prepare(
        `SELECT p.id AS plugin_id, p.plugin_path, p.display_name, r.full_name
           FROM plugin_favorites fav
           JOIN plugins p ON p.id = fav.plugin_id
           JOIN repositories r ON r.id = p.repository_id
          WHERE fav.user_id = ? AND fav.folder_id = ?
          ORDER BY fav.created_at ASC, p.id ASC`,
      )
      .all(ctx.userId, folder.id) as Array<{
      plugin_id: string;
      plugin_path: string;
      display_name: string | null;
      full_name: string;
    }>;
    return {
      folderId: folder.id,
      name: folder.name,
      plugins: rows.map((row) => ({
        pluginId: row.plugin_id,
        label: `${row.display_name ?? row.full_name}${row.plugin_path !== '.' ? ` / ${row.plugin_path}` : ''}`,
      })),
    };
  });

  return (
    <div>
      <h1>新建整合包</h1>
      <div className="me-layout">
        <MeNav current="packs" />
        <div>
          <p className="muted" style={{ marginTop: 0 }}>
            发布即冻结：名称、用途、说明、DSH 版本、配置模板、实测声明与插件清单都会随「第 1 版」保存下来。
            之后改内容请<Link href="/me/packs">发布新版本</Link>。
          </p>
          <PackCreateForm folders={options} />
        </div>
      </div>
    </div>
  );
}
