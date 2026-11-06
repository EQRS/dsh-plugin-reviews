/**
 * 收藏目标类型的解析（三个路由共用一份，免得各写一份校验还写得不一样）。
 *
 * 口径：
 *  - 缺省（没传 / 传 null）→ `plugin`。**这是故意的**：`/api/me/favorites` 在 0039 之前
 *    只有插件一种语义，老前端（收藏按钮、老收藏页）不带 kind，必须照旧按插件走。
 *  - 传了但不是三类之一 → 返回 `null`，由调用方抛 `input_invalid`。
 *    不在这里直接抛，是因为有的路由对"非法 kind"要说具体的 message。
 */

import type { FavoriteTargetKind } from '@/server/modules/interactions';

const KINDS: readonly FavoriteTargetKind[] = ['plugin', 'pack', 'post'];

export function isFavoriteTargetKind(value: unknown): value is FavoriteTargetKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/**
 * 解析 kind。缺省给 `plugin`；非法返回 `null`。
 * `undefined` / `null` / 空串都按缺省处理（查询串里 `?kind=` 是空串）。
 */
export function parseKind(raw: unknown): FavoriteTargetKind | null {
  if (raw === undefined || raw === null || raw === '') return 'plugin';
  return isFavoriteTargetKind(raw) ? raw : null;
}
