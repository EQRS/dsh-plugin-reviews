'use client';

/**
 * 收藏按钮（容器）：插件详情页的老调用点仍用这个名字。
 *
 * 真正的选择器 UI 在 `favorite-picker.tsx`（纯展示层），这里只负责判断会不会被点
 * （`authenticated`）以及是否需要禁用。新调用点请优先用 `FavoritePicker`。
 */

import { FavoritePicker } from './favorite-picker';

export function FavoriteButton({
  pluginId,
  initialFavorited,
  initialFolderId = null,
  authenticated,
}: {
  pluginId: string;
  initialFavorited: boolean;
  /** 从收藏夹点进来时预选的夹子（详情页从 ?from= 解析后传入）；拿不到就 null。 */
  initialFolderId?: string | null;
  authenticated: boolean;
}) {
  return (
    <FavoritePicker
      kind="plugin"
      targetId={pluginId}
      initialFavorited={initialFavorited}
      initialFolderId={initialFolderId}
      authenticated={authenticated}
    />
  );
}
