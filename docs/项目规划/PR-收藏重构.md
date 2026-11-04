# PR：收藏重构（三类内容共用收藏夹）

分支 `feat/favorites-v2` → `feat/forum`（依赖讨论区的帖子表，**合入顺序：`feat/packs` → `feat/forum` → 本分支**）。

---

## 先说结论

收藏从「插件独占」扩成**插件 / 整合包 / 帖子三类共用一套收藏夹体系**，夹只装同类；
老的 `/me/favorites` 拆成 `/plugins`、`/packs`、`/posts` 三个子页，老链接保留。

没有新增任何依赖。对外行为里**只改了一条**：`POST /api/packs/{packId}/favorite` 现在写新表，
它与 `/me/favorites?kind=pack` 从此同源 —— 这正是本 PR 要修的那个读写分裂。

设计口径来自 `docs/项目规划/设计-讨论区与收藏重构.md` §3.4 / §4.3 与决策 D1–D11。

---

## 迁移 0039

`0039_favorite_folders_target_kind.sql`（120 行，自管事务，带 `-- dsh:migration-transaction=off`）：

1. 重建 `favorite_folders` 加 `target_kind`，唯一索引从 `UNIQUE(user_id) WHERE is_default=1`
   改为 `UNIQUE(user_id, target_kind) WHERE is_default=1`（0019 的口径让三类默认夹互相抢位置）。
2. 建 `pack_favorites` / `post_favorites`，结构一致（`user_id + 目标 id + folder_id + created_at`）。
3. 老数据：`plugin_pack_favorites` → `pack_favorites`，并给每个收藏过整合包的用户补建 pack 默认夹。

**专门踩过的四个坑**（都写进了文件头注释，别重犯）：
索引名库级唯一（旧索引必须先删）；新索引必须等 `RENAME` 之后再建；重建被外键引用的表后依赖表外键会自动改指新表；
SQLite 没有 `BEFORE COMMIT` 触发器，条数断言只能靠测试。

**取舍**：`plugin_pack_favorites` **保留不删**，只拷数据。留一行退路比删表安全，确认无碍后再单独清理。

---

## 服务层（`interactions/index.ts`）

一个 `FAVORITE_TABLES` 映射（类型 → 表名 + 目标列）管住三类读写，差异只剩「能不能收藏」的判定：

| 类型 | 能不能收藏 |
|---|---|
| 插件 | 行存在即可 |
| 整合包 | 至少有一个公开版本（`release_number` 非空、`published`、未撤回未隐藏） |
| 帖子 | 未删除且 `review_state='published'`（待审的拒绝——举报者本来就看不到它） |

**已在夹里的老收藏不因目标后来不可用而消失**：作者删帖后，收藏者仍要看到痕迹。

新增 `toggleFavorite` / `setFavoriteInKind` / `isFavorited` / `favoritedIdsAmong` / `listFavoritePacks` / `listFavoritePosts`；
`listFavoriteFolders` / `createFavoriteFolder` 多一个 `kind` 参数，**默认 `plugin`** 以保住老调用点；
`getFavoriteFolder` 返回 `{ folder, plugins, packs, posts }` 四元组，按夹类型只填一份。

`setFavorite(ctx, {pluginId})` 那个插件专用老入口**没删**——`tests/favorites.test.ts` 依赖它。

---

## 两套表合一（本 PR 的关键修复）

改之前：

```
整合包详情页「☆ 收藏」 → POST /api/packs/{id}/favorite → packs.togglePackFavorite → plugin_pack_favorites（旧表）
新收藏页 ?kind=pack     → interactions.listFavoritePacks                → pack_favorites（新表）
```

**两边对不上**：详情页收藏了，新收藏页看不到；新页面取消了，详情页还显示已收藏。

改之后三处读写全部落在 `pack_favorites`：路由改走 `interactions.toggleFavorite`，
`packs.togglePackFavorite` 变成转发（保调用点不打断），`favorite_count` 三处统计与 `packs.listFavoritePacks`
（分页版，**保留**）统一读新表。

---

## 接口

抽了 `src/app/api/_lib/kind.ts` 的 `parseKind`，五个路由共用一份校验。**兼容口径**：不传 kind 一律按 `plugin`。

| 路由 | 变化 |
|---|---|
| `GET /api/me/favorites` | `?kind=`；返回多一个 `kind` 与泛化的 `items`，**`plugins` 字段原样保留** |
| `POST /api/me/favorites` | 接受三类；有 `folderId` 走 `setFavoriteInKind`，没有走 toggle；**老写法 `{pluginId}` 仍按插件走** |
| `DELETE /api/me/favorites` | 加 `?targetId=&kind=`；**老写法 `?pluginId=` 仍按插件走** |
| `GET/POST /api/me/favorites/folders` | 认 `kind`，缺省 `plugin`；重名只在同类型内查 |
| `/api/packs/{packId}/favorite` | 改走 interactions（见上） |

非法 kind 一律 **400**，不静默回落到插件——把写错当成成功是最难查的那种 bug。

---

## 页面与组件

- `/me/favorites` → `redirect('/me/favorites/plugins')`，带 `q` 一并带过去。
- `/me/favorites/plugins` 是原来那一页（收藏夹列表 + 标题搜索）**原样搬来**，改用 `listFavoriteFolders(ctx,'plugin')`。
- `/me/favorites/packs`、`/posts` 新建，跨夹聚合列出，带所在夹名；已删帖 / 无可公开版本包照常显示状态。
- `/me/favorites/{folderId}` 按 `folder.targetKind` 分派渲染（以前只读 `data.plugins`，整合包夹点进去会是空的）。
- 三个子页顶部有统一的切换条 `FavoritesTabs`。
- `favorite-button.tsx` 拆成两层：`FavoritePicker`（`favorite-picker.tsx`，纯展示、不认识登录态）
  + `FavoriteButton`（容器）。这样**服务端页面能直接内联复用**，初始状态由服务端读好传下去。
- 整合包详情页改用 `FavoritePicker`，`pack-favorite-button.tsx` 删除（它的计数来自旧表，换表后口径也不对了）。
- 帖子详情页新增收藏按钮（`isFavorited(ctx,'post')` 预读）。
- `/me/packs` 的「我收藏的」标签**改成链到 `/me/favorites/packs`**，老 `?tab=favorites` 链接直接重定向。

---

## 验证

- `tsc --noEmit` → **exit 0**。
- 全量 `vitest` → 见下方「实测结果」。
- 新增两个测试文件：
  - `tests/favorites-targets.test.ts`（12 项）：默认夹按类型隔离、夹只装同类、老数据迁移不丢、软删帖子仍留痕。
  - `tests/favorites-api.test.ts`（4 项）：**老写法不带 kind 仍按插件走**（这条抓出过一次真回归：
    我第一版把 `{pluginId}` 当成非法请求回了 400）、kind=pack 走新表、非法 kind 400、同名夹只在同类型内冲突。
- `tests/packs.test.ts` 新增 1 项「详情页 / 旧分页列表 / 新收藏页三处读写的是同一张表」——
  原有用例在读写分裂时**也是绿的**，说明它们没盯住这件事，所以补了这条。

---

## 已知取舍（请重点看）

1. **`plugin_pack_favorites` 还在库里**，只是不再被读写。0039 刻意不删：删表不可逆，而它现在只是死数据。
   确认新版上线无碍后再单开迁移清理。
2. **`packs.listFavoritePacks`（分页版）保留**，与新收藏页的 `interactions.listFavoritePacks`（不分页、跨夹）
   并存。两者读同一张表，但用途不同：前者给 /me/packs 的分页视图，后者给收藏页的平铺列表。
   严格说有一份是冗余的，删哪个都行——留给使用者定。
3. **`DELETE` 对 pack/post 的语义**：服务层只有 toggle，没有单独的「取消」。路由里遇到未收藏状态会多 toggle 一次
   来保证最终是「未收藏」，属于两条语句而非一个事务。插件走原来的 `removeFavorite`，不受影响。
4. **路由优先级**：`plugins`/`packs`/`posts` 三个静态段优于 `[folderId]` 动态段。folderId 是 UUIDv7，
   实际不会撞这三个词；万一撞了，那个夹打不开（设计文档 §4.3 已接受这个取舍）。
5. **`/me/favorites/packs|posts` 不逐夹展开**，直接跨夹平铺。整合包收藏量级远小于插件，分夹页面的收益
   抵不上多一次点击；夹仍然存在、能命名，只是不在这里逐夹展开。

---

## 不在本 PR 范围

- 回复的**编辑 / 删除 UI**（服务层有 `deleteReply`，页面没入口）。
- 后台没有列出 `review_state='pending_review'` 帖子的页面。
- AI 翻译功能（归主创）。
