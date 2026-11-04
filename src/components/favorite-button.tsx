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
  authenticated,
}: {
  pluginId: string;
  initialFavorited: boolean;
  authenticated: boolean;
}) {
  return (
    <FavoritePicker
      kind="plugin"
      targetId={pluginId}
      initialFavorited={initialFavorited}
      authenticated={authenticated}
    />
  );
}
