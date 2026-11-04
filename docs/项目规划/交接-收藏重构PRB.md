# 交接文档 · PR B 收藏重构（第二版）

> 写于 2026-11-04。上一段对话把 **PR A（讨论区）做完并推送**，**PR B（收藏重构）只做了一半**：
> 后端与迁移已完成、全量测试绿，**页面与接口适配没做**，而且还有一处读写分裂的悬空点没接。
> 接手的人从 §6 继续。本版相对第一版的改动见文末 §10。

> **§6 已于 2026-11-04 全部完成**（接手会话），本文档现在的用途是「这次改了什么、为什么这么改」的记录。
> 分支已按使用者裁定拆出：**`feat/favorites-v2`**（自 `feat/forum` 的 `6781107` 拉出），
> 六个小节全部落地，新增测试 16 项。完成情况与剩余风险见文末 **§11 完成记录**。

---

## 1. 一句话现状

| 项 | 状态 |
|---|---|
| PR A 讨论区 | **已完成**，分支 `feat/forum`，10 个提交，head = `6781107 docs: 补讨论区 PR 描述`，已推送 |
| PR B 收藏重构 | **完成一半**：迁移 0039 + 服务层改造 + 12 个新测试**已写好且全量通过**，但**未提交**；接口与页面仍是「只认插件」的旧形态 |
| 现在能不能提交 | 能提交、能编译、能过测试，但**功能不完整**，而且整合包收藏新旧两套表并存（见 §6.4） |

当前工作区（分支 `feat/forum`）：

```
 M src/server/modules/interactions/index.ts       (+448 / -58)
 M tests/interactions.test.ts                      (一条旧断言改成新语义)
?? migrations/0039_favorite_folders_target_kind.sql
?? tests/favorites-targets.test.ts
?? docs/项目规划/交接-收藏重构PRB.md              （本文档）
```

**没另开分支**：PR B 的改动和 PR A 在同一棵树上。要不要拆分支、怎么拆，归使用者定，别自己决定。

---

## 2. 运行环境（照抄即可）

`<仓根> = D:\natnat\lingshu\_work\dsh-plugin-reviews-new`

| 工具 | 路径 |
|---|---|
| node | `C:\Users\30951\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| git | `C:\Users\30951\tools\git\cmd\git.exe` |
| gh | `D:\natnat\lingshu\_work\gh\bin\gh.exe`（`GH_CONFIG_DIR=D:\natnat\lingshu\_work\ghcfg`） |

在仓根执行：

```powershell
# 类型检查
& '<node>' node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 单个测试文件
& '<node>' node_modules/vitest/vitest.mjs run tests/favorites-targets.test.ts

# 全量（约 163 秒，务必放后台作业；前面接 Select-Object 会让作业显示 exit 1，别被吓到）
& '<node>' node_modules/vitest/vitest.mjs run
```

**推送**（PAT 不写进文档，向使用者要）：

```
git -c http.schannelCheckRevoke=false -c http.sslVerify=false -c http.version=HTTP/1.1 \
    push https://x-access-token:<PAT>@github.com/EQRS/dsh-plugin-reviews.git feat/forum:feat/forum
```

推完用 `git ls-remote <url> refs/heads/feat/forum` 核对哈希，**不要相信 PowerShell 包装过的 stderr**。

---

## 3. 分支与 PR

| 分支 | 内容 | 迁移号 |
|---|---|---|
| `main` | 基线，head = `dd2154c` | — |
| `feat/packs` | 精选专栏 + 问题反馈 | 0033 / 0034 / 0036 |
| `feat/forum` | 讨论区（PR A）+ 收藏重构（PR B，未完成） | 0037 / 0038 / **0039** |
| `fix/home-plugin-spacing` | 首页插件间距，独立 | — |

**合并顺序：`feat/packs` 先，`feat/forum` 后。**

> 注意：最近一次核对时本地看到的 `main` 是 `c8d86e6`，远端 `main` 是 `dd2154c`——**远端前进过**。
> 接手第一件事就是 `git fetch` 看 main 是否又动了、需不需要 rebase（使用者的硬要求）。

**PR 由使用者自己开、自己改，不要代开代改**（PAT 没有 `pull_requests:write`）。

---

## 4. 已确认的设计口径（照做，不要重新发明）

来自 `docs/项目规划/设计-讨论区与收藏重构.md` §3.4 / §4.3 与决策 D1–D11：

1. 三类内容（插件 / 整合包 / 帖子）**共用一套收藏夹体系**，但**夹只装同类**。
2. 默认夹**每类各一个**（0019 的 `UNIQUE(user_id) WHERE is_default=1` 是错的口径，必须改成 `(user_id, target_kind)`）。
3. 「能不能收藏」的口径：
   - 插件：存在即可；
   - 整合包：**至少要有一个公开版本**（`release_number IS NOT NULL AND review_status='published'`，且未撤回未隐藏）；
   - 帖子：未删除且 `review_state='published'`（待审的拒——举报者根本看不到它）。
   - **已在夹里的老收藏不因目标后来不可用而消失**（作者删帖后收藏者仍看到痕迹）。
4. 页面：`/me/favorites` → `/me/favorites/plugins`，另有 `/me/favorites/packs`、`/me/favorites/posts`；
   `/me/favorites/{folderId}` 旧链接保留。
5. 删夹 = 删夹内收藏；**默认夹不可删**；改名重名检查**只在同一类型内**（插件夹与帖子夹可同名）。

---

## 5. 已完成的部分

### 5.1 迁移 `migrations/0039_favorite_folders_target_kind.sql`（120 行）

自管事务（第一行 `-- dsh:migration-transaction=off`）。顺序：

`PRAGMA foreign_keys=OFF` → `BEGIN` → 重建 `favorite_folders`（加 `target_kind`、`UNIQUE(user_id,target_kind,name)`）
→ 拷贝老数据（全部标 `'plugin'`）→ 删旧索引 → 删旧表 → 改名 → 建新索引
（`uq_favorite_folders_default ON favorite_folders(user_id, target_kind) WHERE is_default=1`）
→ 建 `pack_favorites` / `post_favorites` → 迁移老整合包收藏 → `COMMIT` → FK ON → `foreign_key_check`。

**四条踩过的坑，别重犯：**

1. **索引名是库级唯一的** —— 不先 `DROP INDEX IF EXISTS uq_favorite_folders_default` 就建同名新索引会报 already exists。
2. **新索引必须等 `ALTER TABLE ... RENAME` 之后再建** —— 建在 `_new` 表上，改名后索引条件跟着旧表名走，报 no such table。
3. 重建被外键引用的表后，**依赖表的外键（含 `ON DELETE CASCADE`）会自动改指新表**（探针实测过），不用重建依赖表。
4. 想在迁移里塞临时触发器做「条数不变」断言 —— **SQLite 没有 `BEFORE COMMIT` 触发器**，已删；数据完整性改由测试覆盖。

**迁移刻意的取舍**（都写在文件头注释里）：
- `plugin_pack_favorites` **保留不删**，只拷数据；确认无碍后再单独清理（留退路）。
- 给每个收藏过整合包的用户**补建 pack 默认夹**，避免老用户进新页面看到「夹不存在」的中间态。
- `pack_favorites` / `post_favorites` 的 `folder_id` 是 `ON DELETE CASCADE`；夹内收藏的「退回默认夹」逻辑在服务层做，不在库里做。

### 5.2 服务层 `src/server/modules/interactions/index.ts`

新增/改动（**这些是已落地、可用、有测试的部分**）：

| 名称 | 作用 |
|---|---|
| `FavoriteTargetKind = 'plugin' \| 'pack' \| 'post'` | 三类目标的联合类型 |
| `FAVORITE_TARGET_LABELS` | 中文名（插件 / 整合包 / 帖子） |
| `FAVORITE_TABLES`（模块私有） | 唯一的「类型 → 表名 + 目标列」映射，读写函数全走它 |
| `ensureDefaultFolderInTx(conn, userId, kind='plugin')` | 按类型建默认夹；只有 plugin 会回填 `folder_id IS NULL` 的历史行 |
| `assertFavoriteTarget(conn, kind, targetId)` | 三类的「能不能收藏」口径集中于此（见 §4.3） |
| `assertFolderOwned(conn, userId, folderId, kind)` | 夹属于本人**且类型匹配**，否则按「不存在」处理 |
| `toggleFavorite(ctx, {kind, targetId})` | 泛化到三类：没收藏 → 进该类默认夹；已收藏 → 取消 |
| `setFavoriteInKind(ctx, {kind, targetId, folderId})` | 下拉选择器用，folderId 必填；`ON CONFLICT` 移动 |
| `isFavorited(ctx, kind, targetId)` | 单条判定（三合一，替代旧的 `isFavorite`） |
| `favoritedIdsAmong(ctx, kind, targetIds)` | 批量判定，避免列表 N+1；空数组直接返回空集 |
| `listFavoriteFolders(ctx, kind='plugin')` | 多出 `kind` 参数，**默认值保住老调用点** |
| `createFavoriteFolder(ctx, name, kind='plugin')` | 同上；重名只在同类型内查 |
| `getFavoriteFolder(ctx, folderId)` | 返回 `{ folder, plugins, packs, posts }` 四元组，按夹类型只填对应那份 |
| `deleteFavoriteFolder` | 按夹自身 `target_kind` 清对应表（以前写死 `plugin_favorites`） |
| `batchFavoriteAction` | 移动目标限定为**插件夹**，防止两类混装 |
| `listFavoritePacks` / `listFavoritePosts` | 跨夹聚合，带 `folderName`，按 createdAt 倒序 |

**注意 `setFavorite(ctx, {pluginId, folderId})` 还在**，是插件专用的老入口（`/api/me/favorites` 在没传 kind 时用它），别顺手删——`tests/favorites.test.ts` 依赖它。

### 5.3 测试

**新增 `tests/favorites-targets.test.ts`（12 个用例）**，盯住四件最容易写坏的事：

1. 默认夹按类型隔离 + **三个默认夹可并存**（这条就是 0019 索引 bug 的鉴别用例）；
2. 夹只装同类（插件收藏塞进帖子夹、整合包收藏塞进插件夹 → `INPUT_INVALID`）；
3. 老数据迁移不丢（`plugin_pack_favorites` → `pack_favorites` 条数不变，且归入 pack 默认夹）；
4. 软删的帖子仍留在收藏里（收藏者要看到痕迹）；待审帖不可收藏。

另外覆盖：整合包收藏写新表且**旧表不再被写**、同类型内查重名 / 跨类型可同名、删夹不误清别的类型、
批量移动限插件夹、`favoritedIdsAmong` 批量判定、迁移后老夹全部标 `plugin`。

**改动 `tests/interactions.test.ts` 一条断言**：原来「收藏整合包」期望 `input_invalid`（"暂不支持"），
现在期望 `target_unavailable`（"整合包不存在。"）——因为整合包收藏已是真功能，这条断言必须跟着改。

**验证状态（2026-11-04 凌晨，实测）**：

- `tsc --noEmit` → **exit 0**
- `tests/favorites-targets.test.ts` → **12 passed**
- `tests/favorites.test.ts` + `tests/packs.test.ts` + `tests/interactions.test.ts` → 分别 17 / 8 passed
- **全量 `vitest run` → 74 个测试文件 / 848 个用例全绿，162.7 秒** ✅

---

## 6. 未完成的部分（PR B 剩下的活）

按依赖顺序做，**6.4 优先级最高**（它会让整合包收藏在旧表 / 新表之间分裂）。

### 6.1 接口适配（不传 kind 就还是插件语义）

| 文件 | 现状 | 要改成 |
|---|---|---|
| `src/app/api/me/favorites/folders/route.ts` | GET / POST 都不认 kind，一律插件 | 从 `?kind=`（GET）与 body `kind`（POST）读，校验取值，缺省 `plugin`；透传给 `listFavoriteFolders(ctx, kind)` / `createFavoriteFolder(ctx, name, kind)` |
| `src/app/api/me/favorites/route.ts` POST | **显式拒绝 `kind='pack'`**（第 61-63 行"整合包收藏将在整合包上线后开放"） | 接受 plugin / pack / post；有 `folderId` 走 `setFavoriteInKind`，没有走 `toggleFavorite`。**注意老语义**：没有 kind 时按 plugin 走 `setFavorite`，别把老前端打断 |
| `src/app/api/me/favorites/route.ts` DELETE | 只认 `?pluginId=` | 加 `?kind=`（缺省 plugin）+ `?targetId=`，或至少让 pack/post 也能走；也可以统一走 POST 的 toggle，但**已发布的行为不要偷偷改** |
| `src/app/api/me/favorites/route.ts` GET | 只返回插件 | 至少保持原字段不变（老页面靠 `plugins`）；新增字段要向后兼容 |
| `src/app/api/me/favorites/folders/[folderId]/route.ts` | PATCH / DELETE 已能工作 | **不用改**（服务层按夹自身类型处理，改名查重已收到同类型内） |
| `src/app/api/me/favorites/batch/route.ts` | 只处理插件 | **保持不变**（服务层已把移动目标限定为插件夹） |

建议抽一个 `parseKind(raw): FavoriteTargetKind | null` 放在 `src/app/api/_lib/` 或直接放 interactions 模块里导出，
免得五个路由各写一份校验。

### 6.2 页面

设计文档 §4.3 要求的四个路径：

| 路径 | 做法 |
|---|---|
| `/me/favorites` | 改成一个 `redirect('/me/favorites/plugins')` 的壳（现有内容整体搬走） |
| `/me/favorites/plugins` | 现 `src/app/me/favorites/page.tsx` 的内容搬过来，`listFavoriteFolders(ctx, 'plugin')` |
| `/me/favorites/packs` | 新建，`listFavoriteFolders(ctx, 'pack')` + `listFavoritePacks` |
| `/me/favorites/posts` | 新建，`listFavoriteFolders(ctx, 'post')` + `listFavoritePosts` |

**路由冲突（已评估，可接受）**：加了 `plugins`/`packs`/`posts` 三个静态段之后，Next 静态段优先于
`[folderId]` 动态段。folderId 是 UUIDv7，实际不会撞这三个词；万一撞了那个夹打不开。
设计文档 §4.3 也写了 `/me/favorites/{folderId}` 旧链接保留。

处理好之后 `src/app/me/favorites/[folderId]/page.tsx` 要按夹类型分派：
现在它只读 `data.plugins`，整合包夹 / 帖子夹进去会是空列表——必须按 `folder.targetKind` 渲染对应的列表。

**三个子页之间的切换条**：抄 `/me/packs` 页的 `tab` 写法，或者做成一排 `Link` + `className="button primary"`。

### 6.3 组件

| 组件 | 现状 | 要改成 |
|---|---|---|
| `src/components/favorite-button.tsx`（215 行） | 只认 `pluginId`；请求写死 `kind:'plugin'`；拉 `/api/me/favorites` 时只找 `plugins[].pluginId` | 泛化成 `FavoriteButton({ kind, targetId, ... })`，接口带 kind；**建议改名为 `FavoritePicker`**（它本质是收藏夹选择器）。改完记得 `src/app/plugins/[pluginId]/page.tsx` 的调用点跟着改 |
| `src/components/pack-favorite-button.tsx`（65 行） | 「一点收藏、再点取消」，无选择器，调 `/api/packs/{packId}/favorite` | 二选一：① 换成泛化后的 `FavoritePicker`（推荐，与插件一致）；② 保持简单但**必须改走新表**（见 6.4）。它的 `count` 来自 `plugin_pack_favorites` 计数，换表后要重新算 |
| 帖子收藏按钮 | **完全没有** | 帖子详情页 `src/app/forum/[slug]/[postId]/page.tsx` 里，第 77-81 行那个 `<div>`（现在只放 `ReportButton`）加一个收藏按钮；`initialFavorited` 用 `service.isFavorited(ctx, 'post', postId)` |
| `src/components/folder-plugin-list.tsx`（158 行） | 只认插件；批量接口只支持插件 | 插件夹继续用它。整合包 / 帖子夹要么复制出 `folder-pack-list` / `folder-post-list`，要么做成泛型（后者更费事，前者更快） |

### 6.4 ⚠️ 最大的悬空点：整合包收藏两套表并存

这是**当前最优先**的一件事，别做页面时绕过去：

```
整合包详情页「☆ 收藏」
  → POST /api/packs/{packId}/favorite
  → packs.togglePackFavorite()          ← 读写 plugin_pack_favorites（旧表）
新收藏页 /api/me/favorites?kind=pack
  → interactions.listFavoritePacks()    ← 读写 pack_favorites（新表）
```

**两边对不上**：在详情页点了收藏，新收藏页里看不到；在新页面取消了，详情页还显示已收藏。

要改的地方：
1. `src/app/api/packs/[packId]/favorite/route.ts` → 改调 `interactions.toggleFavorite(ctx, { kind: 'pack', targetId: packId })`
   （`assertFavoriteTarget` 里的整合包口径与旧实现完全一致，迁移那段是照它抄的）。
2. `src/server/modules/packs/index.ts` 的 `togglePackFavorite`（第 1546 行起）→ **删掉**，或改成转发到 interactions。
3. `src/server/modules/packs/index.ts` 的 `listFavoritePacks`（第 1656 行起，分页版，返回 `favoriteCount`）→
   要么改成读 `pack_favorites`，要么直接删掉（新收藏页已有不分页的 `interactions.listFavoritePacks`）。
   **注意 `tests/packs.test.ts:282-288` 正在测它**，删的话测试也要一起改。
4. `favorite_count` 计数（`packs/index.ts` 第 1297 / 1352 / 1463 行）现在统计 `plugin_pack_favorites`，
   换表后要改成统计 `pack_favorites`，否则整合包卡片上的收藏数会一直是 0。
5. `src/app/me/packs/page.tsx` 的「我收藏的」标签页（第 148-210 行）**与新页面重复**：
   建议把该标签改成链接到 `/me/favorites/packs`，或直接删掉那个 tab。

### 6.5 入口与导航

- `src/components/me-nav.tsx` 第 38-44 行：「收藏」指向 `/me/favorites`（重定向后会落到 plugins，可保留）。
- `src/app/me/favorites/page.tsx` 里有个不相干的 `<Link href="/me/packs/new">创建整合包</Link>`（第 114 行），
  搬页面时顺手删掉或挪走——它跟收藏夹无关。

### 6.6 文档

- `docs/项目规划/设计-讨论区与收藏重构.md`：**第 4 行、第 190 行、第 208 行仍写「0038（收藏重构）」，实际是 0039**
  （0038 被讨论区草稿占用了）。§11 实施顺序里的「迁移 0038 + 三个子页」也要改。
- PR B 描述还没写：照 `docs/项目规划/PR-讨论区.md` 的体例写一份 `docs/项目规划/PR-收藏重构.md`。

### 6.7 PR A 遗留（不在 PR B 范围，记一笔）

- 回复的**编辑 / 删除 UI** 没做（服务层有 `deleteReply`，页面没入口）。
- 后台没有列出 `review_state='pending_review'` 帖子的页面——发帖自动审核挡下来的帖子，目前没有放行入口。

---

## 7. 必须遵守的纪律（不是客套话，都是踩过的坑）

1. **服务构造函数统一 `{ db }`**：`createInteractionsService({ db })`、`createForumPostService({ db })`。
   `createPacksService` 的签名是 `deps: { db?: SqliteDatabase } = {}`，可以空参调，但别混用两种写法。
2. **`withTransaction(fn, db)` 的回调参数是 `Tx`，要用 `tx.db` 操作库**；**绝不嵌套 `withTransaction`**。
   `withRead(fn, db)` 直接给 `SqliteDatabase`。
3. **改表结构必须走迁移文件**；迁移按文件名 `.sql` **字典序**跑；文件里有 `BEGIN;`/`COMMIT;`
   就必须第一行 `-- dsh:migration-transaction=off`。
4. **测试必须用真实临时库 + 真实迁移**（`tests/support/db.ts` 的 `createTestDb()`），不许 `:memory:` 冒充。
   fixture：`insertUser` / `insertRepository` / `insertPlugin`。
5. **命令一律经 python 或显式 UTF-8 调用**（`subprocess.run(..., encoding='utf-8', errors='replace')` + `PYTHONUTF8=1`），
   不裸跑 Windows 原生命令；仓库路径写相对路径，本机绝对路径用中性占位（`<仓根>`）。
6. **每次改动前先确认 `main` 是否前进**（使用者明确要求）。
7. 使用者原话：**「pr由我来改，你不需要改」**。不要代开 / 代改 PR。
8. **AI 翻译功能归主创**，别在这个 PR 里实现。
9. 报错对象统一用 `err.input / forbidden / unavailable / conflict / internal`；
   测试里判错误码用 `isDomainError(e)` + `ErrorCodes.*`（`INPUT_INVALID`、`TARGET_UNAVAILABLE`）。

---

## 8. 接手第一步

```powershell
cd <仓根>
git -c http.schannelCheckRevoke=false -c http.sslVerify=false fetch \
    https://x-access-token:<PAT>@github.com/EQRS/dsh-plugin-reviews.git main
git log --oneline -1 FETCH_HEAD    # 远端 main 上次见是 dd2154c，又动了就先 rebase
git status                          # §1 那五处改动应当还在
& '<node>' node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # 期望 exit 0
& '<node>' node_modules/vitest/vitest.mjs run                          # 期望 74 files / 848 tests 全绿
```

全量绿之后按这个顺序做：

**6.4（整合包两套表合一）→ 6.1（接口带上 kind）→ 6.2（三个子页）→ 6.3（组件）→ 6.5（入口）→ 6.6（文档 + PR 描述）**

每完成一块就 `tsc --noEmit` + 该块的测试文件；全部做完再跑一次全量，然后交给使用者提 PR。

---

## 9. 速查：改哪个文件影响什么

```
interactions/index.ts       收藏的唯一真源（三类共用的读写与判定）；改这里要跑 favorites*.test.ts
migrations/0039_*.sql       收藏夹结构 + 两张新收藏表 + 老数据搬迁；改这里要跑 favorites-targets.test.ts
api/me/favorites/**         收藏的对外接口（仍是插件语义，见 §6.1）
api/packs/*/favorite        整合包收藏的旧入口（要改，见 §6.4）
packs/index.ts              整合包服务：togglePackFavorite / listFavoritePacks / favorite_count 三处涉旧表
app/me/favorites/**         收藏页（单页要拆四个，见 §6.2）
components/favorite-*       收藏交互（要泛化，见 §6.3）
```

---

## 10. 本版相对第一版改了什么

- **验证状态更新**：第一版写「全量测试没跑」；本版已跑，**74 files / 848 tests 全绿，162.7 秒**。
- **新增 §4「已确认的设计口径」**：把设计文档 §3.4 / §4.3 / D1–D11 的结论提前，接手时不用再翻全文。
- **新增 §6.4 的完整拆分**：第一版只说「packs 模块有悬空点」，本版列出了 5 处要改的位置
  （含 `favorite_count` 计数、`tests/packs.test.ts:282-288` 的测试、`/me/packs` 标签页重复）。
- **新增 §6.7 PR A 遗留**、**§9 文件影响速查**。
- **补了 `main` 最新哈希**（远端 `dd2154c`，本地看到的还是 `c8d86e6`，接手先 fetch）。
---

## 11. 完成记录（2026-11-04 接手会话）

### 11.1 使用者裁定的四条

| 问题 | 裁定 |
|---|---|
| 分支怎么拆 | 拆：从 `feat/forum@6781107` 拉 **`feat/favorites-v2`**，PR B 的改动整体搬过去 |
| PAT / 凭证 | 用本机既有 git 凭证（不写进文档） |
| `/me/packs` 的「我收藏的」标签 | **改链**到 `/me/favorites/packs`，老 `?tab=favorites` 直接重定向 |
| `packs.listFavoritePacks` 分页版 | **保留**，改为读 `pack_favorites` |

### 11.2 六节的落地情况

| 小节 | 状态 | 落点 |
|---|---|---|
| 6.4 两套表合一 | 完成 | `api/packs/[packId]/favorite/route.ts` 改走 interactions；`packs.togglePackFavorite` 变转发；三处 `favorite_count` 与 `listFavoritePacks` 改读新表 |
| 6.1 接口带 kind | 完成 | 新建 `src/app/api/_lib/kind.ts`（`parseKind`，缺省 plugin）；`favorites`、`folders` 两个路由改造 |
| 6.2 页面 | 完成 | `/me/favorites` 变重定向壳；新增 `plugins`/`packs`/`posts` 三子页；`[folderId]` 按 `targetKind` 分派 |
| 6.3 组件 | 完成 | `favorite-picker.tsx`（纯展示）+ `favorite-button.tsx`（容器）；整合包详情页改用 picker；帖子详情页新增收藏；`pack-favorite-button.tsx` 删除 |
| 6.5 入口 | 完成 | `/me/packs` 收藏标签改链 + 重定向；`/me/packs/new` 死链已随旧收藏页搬走一并移除 |
| 6.6 文档 | 完成 | 设计文档三处 0038→0039；`PR-收藏重构.md` 已写 |

### 11.3 与原计划的差别（都是被测试或实际情况逼出来的）

1. **`FavoritePicker` 拆成了两层**，不是把 `FavoriteButton` 直接改名。
   原因：`FavoriteButton` 是 `'use client'`，而插件详情页 / 整合包详情页 / 帖子详情页都是**服务端组件**。
   服务端渲染客户端组件只能传可序列化 props，想在服务端直接内联复用就得把展示层独立出来。
   拆完之后服务端页面可以直传 `initialFavorited`，省掉客户端一次往返。
2. **`POST /api/me/favorites` 补了 `pluginId` 老写法兼容**。第一版实现只认 `targetId`，
   把老前端传的 `{pluginId}` 判成了 400——`tests/favorites-api.test.ts` 当场抓出来。
3. **`tests/search-button.test.tsx` 的搜索页清单改了一行**：搜索表单从 `/me/favorites/page.tsx`
   搬到了 `/me/favorites/plugins/page.tsx`，测试盯的形态规则本身没变。

### 11.4 新增/改动的测试

- 新增 `tests/favorites-api.test.ts`（4 项）：老写法兼容、kind=pack 走新表、非法 kind 400、同名夹跨类型不冲突。
- `tests/packs.test.ts` 新增 1 项：**详情页 / 旧分页列表 / 新收藏页读同一张表**。
  原有用例在读写分裂时是绿的，说明它们没盯住这件事——这条是为它补的。
- `tests/favorites-targets.test.ts`（12 项）沿用，未改。

### 11.5 仍需使用者决定或留意

1. **`plugin_pack_favorites` 仍在库里**（0039 刻意不删），现在只被读不被写。确认上线无碍后再单开迁移清理。
2. **两套 `listFavoritePacks` 并存**（分页版在 packs 模块、不分页跨夹版在 interactions）。都读新表，用途不同，删哪个由使用者定。
3. **PR 尚未开**：按使用者要求「pr 由我来改」，本会话只做到分支与测试，没有开 PR、没有推送。
4. **远端 `main` 已核对 = `dd2154c`**（与本文档 §3 一致，**不需要 rebase**）。
   `origin` 已从 `https://gh-proxy.com/...furongjun-lingshu/...` **改回上游直连**
   `https://github.com/EQRS/dsh-plugin-reviews.git`——原来那个镜像地址连接被重置，且账号也写错了。
   排查记一笔：第一轮我把镜像不通误判成"凭证失效"，**应当先看 `remote.origin.url` 的实际指向**。
5. **推送凭证已验证可用**：`~/.dsh/.env.txt` 的 `GH_TOKEN`（fine-grained PAT），
   `git push --dry-run` 到上游返回 `[new branch] feat/favorites-v2`，说明有写权限。
