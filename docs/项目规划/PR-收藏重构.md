# PR：收藏重构（三类内容共用收藏夹）

分支 `feat/favorites-v3` → `feat/forum`（**依赖 PR A 的帖子表，合入顺序：PR A 先、本 PR 后**）。

> **本分支已按新的 PR A 重建。** 原先的 `feat/favorites-v2` 基于 `feat/forum@6781107`；
> PR A 复审后 rebase 到 `685c6a9`，历史被重写，直接合并会让 37 个文件全部变成 `add/add` 冲突。
> 现在用 `git rebase --onto fix/forum-review feat/forum` 把 4 个提交摘下来重新接到新 PR A 上，
> **冲突从 37 处降到 1 处**（且那 1 处是真问题，见下）。后续 PR A 再有改动，同一条命令即可跟上。

---

## 先说结论

收藏从「插件独占」扩成**插件 / 整合包 / 帖子三类共用一套收藏夹体系**，夹只装同类；
老的 `/me/favorites` 拆成 `/plugins`、`/packs`、`/posts` 三个子页，老链接保留。

没有新增任何依赖。对外行为里**只改了一条**：`POST /api/packs/{packId}/favorite` 现在写新表，
它与 `/me/favorites?kind=pack` 从此同源——这正是本 PR 要修的那个读写分裂。

设计口径来自 `docs/项目规划/设计-讨论区与收藏重构.md` §3.4 / §4.3 与决策 D10–D11。

---

## 迁移 0039

`0039_favorite_folders_target_kind.sql`（自管事务，首行带 `-- dsh:migration-transaction=off`）：

1. 重建 `favorite_folders` 加 `target_kind`，唯一索引从 `UNIQUE(user_id) WHERE is_default=1`
   改为 `UNIQUE(user_id, target_kind) WHERE is_default=1`——0019 的口径让三类默认夹互相抢位置。
2. 建 `pack_favorites` / `post_favorites`，结构一致（`user_id + 目标 id + folder_id + created_at`）。
3. 老数据：`plugin_pack_favorites` → `pack_favorites`，并给每个收藏过整合包的用户补建 pack 默认夹。

**四个踩过的坑**（都写进了文件头注释）：索引名库级唯一（旧索引必须先删）；新索引必须等 `RENAME` 之后建；
重建被外键引用的表后依赖表外键自动改指新表；SQLite 没有 `BEFORE COMMIT` 触发器，条数断言只能靠测试。

**取舍**：`plugin_pack_favorites` 保留不删，只拷数据。留一行退路比删表安全，确认无碍后再单独清理。

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
新收藏页 ?kind=pack    → interactions.listFavoritePacks              → pack_favorites（新表）
```

**两边对不上**：详情页收藏了，新收藏页看不到；新页面取消了，详情页还显示已收藏。

现在 `packs.togglePackFavorite` 变成转发（保调用点不打断），三处 `favorite_count` 统计与 `packs.listFavoritePacks`
都改读 `pack_favorites`。`tests/packs.test.ts` 新增一条用例盯住「详情页 / 旧分页列表 / 新收藏页读同一张表」——
原有用例在读写分裂时是绿的，说明它们没盯住这件事。

---

## 页面

| 路径 | 内容 |
|---|---|
| `/me/favorites` | 重定向到 `/me/favorites/plugins`（带 `q` 时一并带过去） |
| `/me/favorites/plugins` | 插件收藏夹 + 标题搜索 |
| `/me/favorites/packs` | 整合包收藏夹（跨夹平铺） |
| `/me/favorites/posts` | 帖子收藏夹（跨夹平铺） |
| `/me/favorites/{folderId}` | 旧链接保留，**内容按夹类型分派** |

**关于 `[folderId]` 的分派**：设计文档原写「仍指向插件收藏夹详情」，那句话成立于只有插件一种夹的时候。
三类夹并存后若不分派，打开整合包夹或帖子夹会是空列表。使用者 2026-11-05 裁定按夹类型分派、路径不变，
设计文档已同步更新。

**组件**：`FavoritePicker`（纯展示，可用于服务端内联）+ `FavoriteButton`（容器）两层拆分。
`pack-favorite-button.tsx` 删除——它的计数来自旧表，换表后口径也不对了。

---

## 本次重建时额外修掉的回归

`main` 在 PR B 拆除期间新增了「精选专栏」（`3afe61b`），给 `/me/favorites` 页脚加了管理员专属的
「创建精选专栏」入口。PR B 把这个页面改成重定向壳时**没有把它带到新的插件子页**，直接合并会丢功能。

现在已补到 `/me/favorites/plugins`，并注明「这段随收藏页一起搬过来，别弄丢」。

> 这是从旧 PR A 拉起的分支容易踩的坑：`main` 在那段时间新增的东西，PR B 完全看不到。

---

## 验证

```
tsc --noEmit   → 0 错误
vitest run     → 82 文件 / 948 用例全绿（200.1 秒）
```

收藏相关测试 34 项：

- `tests/favorites-targets.test.ts`（12 项）：默认夹按类型隔离、三类默认夹可并存、夹只装同类、
  老数据迁移不丢、软删帖子仍留痕、待审帖不可收藏、同类型内查重名 / 跨类型可同名、删夹不误清别的类型。
- `tests/favorites-api.test.ts`（4 项）：老写法不带 kind 仍按插件走（这条抓出过一次真回归——
  第一版把 `{pluginId}` 判成 400）、kind=pack 走新表、非法 kind 400、同名夹只在同类型内冲突。
- `tests/favorites.test.ts`（9 项）、`tests/packs.test.ts`（9 项）沿用。

---

## 已知取舍

1. **`plugin_pack_favorites` 还在库里**，只是不再被读写。0039 刻意不删：删表不可逆。
   确认新版上线无碍后再单开迁移清理。
2. **`packs.listFavoritePacks`（分页版）与新收藏页的 `interactions.listFavoritePacks`（不分页、跨夹）并存**。
   两者读同一张表、用途不同：前者给 `/me/packs` 的分页视图并带 `favoriteCount`，后者给收藏页的平铺列表。
   **保留两者是有意的**：合并需要给 interactions 版加分页与摘要参数，反而把「收藏唯一真源」这根线拉粗了。
3. **`/me/favorites/packs|posts` 不逐夹展开**，直接跨夹平铺。整合包与帖子的收藏量级远小于插件，
   分夹页面的收益抵不上多一次点击；夹仍然存在、能命名，只是不在这里逐夹展开。
4. **路由优先级**：`plugins`/`packs`/`posts` 三个静态段优于 `[folderId]` 动态段。folderId 是 UUIDv7，
   实际不会撞这三个词；万一撞了，那个夹打不开（设计文档 §4.3 已接受）。

---

## 不在本 PR 范围

- 回复的**编辑 / 删除 UI**（服务层有 `deleteReply`，页面没入口）。
- 后台没有列出 `review_state='pending_review'` 帖子的页面。
- AI 翻译功能（归主创）。

---

## 合入顺序

**PR A（`feat/forum`）先合，本 PR 后合。** 本 PR 的 `post_favorites` 外键指向 `forum_posts`，
迁移 0039 排在 0037/0038 之后。若 PR A 在复审中被改动，本分支用同一条命令跟上：

```bash
git rebase --onto <新的 PR A 提交> feat/forum feat/favorites-v3
```
