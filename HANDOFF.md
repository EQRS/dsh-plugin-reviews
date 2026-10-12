# 交接书 · DSH 插件测评网站

> 2026-10-12（第二轮会话收尾）。上一版交接书的内容已并入本文件，旧的过时条目已直接改掉。
> **目的**：让接手的人（或下一个会话的我）不必依赖上一轮的记忆，只看本文件 + 仓库就能继续。

---

## 0. 一句话状态

**核心链路已实现、真机验证、并且真的用浏览器点通了**：
登录 → 收录插件 → **从插件页写评测** → 保存 → 提交 → **真 worker 发布** → 公开页可读 → 评论公开。

`tsc` exit 0、单测 **357/357**、HTTP 验收 **16+20+14**、端到端 **18/18**，浏览器点击链路 9 步走完（§5.2）。
**已提交并推送：`938f32a`（61 files）→ `origin/main`。**

**当前没有待办的技术债**；剩下的都是"要么等主人给密钥，要么本来就在切片范围外"（§3）。

---

## 1. 本轮（相对 `e59a71a`）做了什么

提交 `938f32a` 的内容分两块。

### 1.1 第一轮已经写好、这轮才验证到的部分

- 真实 GitHub OAuth（PKCE S256 + state 摘要 + 浏览器绑定 Cookie + 一次性消费）
- 真实 api.github.com 收录探针（`POST /api/plugins` 原先永远是 503 的桩）
- worker 的 4 个处理器（原先 handlers 注册表是**空 `{}`**）
- 图片上传全链路、Markdown sanitize 渲染、5 个前端组件 + 2 个页面、作者撤回
- `next.config.ts` 的 `allowedDevOrigins`

### 1.2 本轮**新发现并修掉**的两个真缺陷

| # | 缺陷 | 怎么发现的 | 修法 |
|---|---|---|---|
| 14 | **评测没有"绑定插件"的入口**：插件详情页（设计文档指定的入口）没挂按钮，`/me` 的「写一篇评测」却建出 `plugin_id` 为空的草稿 —— 它能保存、能显示，**一点提交就报"请选择插件"**，而界面上没有任何办法补救 | **人工浏览器点击链路**。HTTP 验收与 357 个单测**全都没碰到这一层**：它们一律直接从 API 带 `pluginId` 建草稿，所以咬不出来 | 插件详情页挂 `StartDraftButton pluginId={plugin.pluginId}`；`/me` 改成引导到插件目录；编辑器顶部明示「关联插件」或「未关联 → 无法提交」 |
| 15 | `acceptance-http.mjs` 的收录断言**过时**：写死要求 `503` | 跑全量验收读出 **15/16**。查因：探针接真实 api.github.com 之后，不存在的仓库**本就该**返回 `400`（`input_invalid` + 具体原因），`503` 只是探针还是桩时的口径 | 改成"明确拒绝且不假装成功"（400/503 + 错误码白名单 + `ok=false`）；再用**变异副本**把 URL 换成真实插件目录（→ 201 成功）验证它会变红 |

> 第 14 条值得记住：**"接口全对、页面走不通"这类缺陷，只有真的去点才会暴露。**
> 当时页面上甚至没有任何提示，用户只会在最后一步撞墙。

---

## 2. 验证状态（**都是真跑出来的数字，附复现命令**）

| 项目 | 结果 | 复现命令 |
|---|---|---|
| 类型检查 | **exit 0** | `npx tsc --noEmit` |
| 单元/集成测试 | **357 passed / 16 files** | `npx vitest run` |
| HTTP 读验收 | **16/16** | `node scripts/acceptance-http.mjs`（需 dev server） |
| HTTP 写验收 | **20/20** | `npx tsx scripts/acceptance-http-write.mjs` |
| 图片上传验收 | **14/14**（可重复运行） | `npx tsx scripts/acceptance-upload.mjs` |
| **端到端整条链** | **18/18** | `npx tsx scripts/acceptance-e2e-chain.mjs` |
| 浏览器点击链路 | **9 步点通**（人工） | 见 README-切片说明.md §5.2 |
| 真实 GitHub 收录 | 成功收录 `packages/bundle/base` | 见 §5.1 |
| 浏览器真登录 | 导航栏变为真实用户 ID + 登出 | 见 §5.2 |

端到端脚本覆盖：登录 → 会话接口 → 收录真实插件 → 建草稿 → 保存 → **过期版本被拒** → 提交(pending)
→ **真 worker 进程** → `published` → 公开修订指针切换 → 匿名可读 → 发评论 → worker 发布
→ 出现在公开列表 → 登出 → 登出后写操作 401。

> ⚠️ 跑 `acceptance-e2e-chain.mjs` 之前**必须先把常驻 worker 停掉**：脚本要自己起 worker，
> 并且会断言**自己那个子进程**的 stdout（`handler_count`）。两个 worker 会抢任务，脚本会误报失败。

---

## 3. 未完成 / 下一步

### 3.1 需要主人动手（我做不了）

1. **真实 GitHub 登录生效**：在 https://github.com/settings/developers 建 OAuth App，
   callback 填 `http://127.0.0.1:3100/api/auth/github/callback`，
   把 Client ID/Secret 写进 `.env.local`，另加 `SESSION_SECRET`（≥32 字节，生产必须）。
   **在主人给出 Client Secret 之前，不能声称"OAuth 已跑通"** —— 代码完整，但没有真往返过。
2. 可选：`GITHUB_TOKEN`（`gh auth token` 的输出）把收录探针限额 60 → 5000 次/小时。

### 3.2 明确未做（**不要当成已完成**）

| 未做 | 说明 |
|---|---|
| 目录发现 / 定时同步 | 只有"粘链接自助收录"；架构 §92—99 的发现与同步未做 |
| 真实外部内容审核 | 内置的只是**本地确定性基础筛查**（词表+长度+刷屏），**不是审核服务**；默认还关着 |
| 后台审核页面 | 只有 API（`/api/admin/submissions` + `.../decisions`） |
| 修订历史界面、搜索筛选 | 快照在库里，但没有读取界面；列表只分页 |
| 多 patch 数组完整核验 | 契约返回单个 `bundlePath`，只核验第一条（见 §4.1） |
| 评论编辑 | 因此评论发布**没有** `superseded` 检查（见 §4.3） |
| Linux/Docker 构建、备份恢复演练 | 只验证了本机 Windows + Node 24 |
| 浏览器自动化 | 无 Playwright；点击链路是**人工**点过一遍，**回归时不会自动重跑** |
| 图片「插入图片」按钮 | 系统文件选择器工具驱动不了，没被浏览器驱动验证过（只验了 HTTP 契约 14/14） |

### 3.3 想继续时的最短路径

```cmd
cd /d "D:\developing\ds民间科研成果展示\插件测评网站"
npx tsc --noEmit                 REM 期望 exit 0
npx vitest run                   REM 期望 357 passed / 16 files
dev.cmd                          REM 迁移 + 自检 + 起 Web（3100）
REM 另开窗口（要让提交自动发布才需要）：
set DSH_REVIEW_CONTENT_SCREEN=basic
dev.cmd worker
dev.cmd accept                   REM 读/写/上传/端到端 四段验收（先停掉常驻 worker）
```

---

## 4. 关键发现与勘误（**接手必读，否则会重犯**）

### 4.1 `dsh.bundle` 是**对象**，不是字符串

最初的任务描述写的是"取 `dsh.bundle` **字符串**"，**这是错的**。上游《打包与安装插件》与真机都确认：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

- `patch` 可以是字符串，**也可以是有序数组**
- 相对锚点是**声明它的 `package.json` 所在目录**（即 `pluginPath`），**不是**仓库根
- 真机复核（`deepseek-ai/deepseek-harness` 的 `packages/bundle/base/package.json`）：
  `dsh = {"bundle":{"patch":"./cordis.patch.yml"}}`，且 `cordis.patch.yml` → HTTP 200

**若照抄错规格，会写出一个永远认为"没有 dsh.bundle"的探针，把真实收录全部拒掉** ——
而单测若也按错规格构造夹具，会一起绿着。

### 4.2 Next dev 在 `127.0.0.1` 上会拦掉客户端资源 → **前端完全不 hydrate**

Next dev 默认把 `127.0.0.1` 视为**跨源**并拦掉 `/_next/*`
（dev server 日志：`Blocked cross-origin request ... from "127.0.0.1"`）。
后果不是"样式有点怪"，而是**客户端组件完全不 hydrate**：导航永远停在"正在读取登录状态…"、
输入框填了按钮仍 disabled。**任何人都会因此判断"前端坏了"，而实际代码没问题。**

已在 `next.config.ts` 加 `allowedDevOrigins: ['127.0.0.1','localhost']`。**只影响 dev，不影响生产构建。**

### 4.3 评论发布：**不能照抄** `publishReview` 的 `superseded` 检查

`publishReview` 用 `reviews.latest_submitted_revision_id !== revision.id` 挡"被新提交取代的旧快照"。
评论侧**不能照抄**：评论提交路径（`src/server/modules/comments`）**从未写过**
`comments.latest_submitted_revision_id`，该列**恒为 NULL**。照抄会让检查永远不通过 ——
**所有评论都判 superseded、一条也发不出去**。曾经真写错过一次，被实跑测试立刻抓出。

评论当前只有"首次提交即修订"一条路径（无编辑后再提交），所以"被取代"在数据上还不可能出现。
**将来若要支持编辑评论，必须同时**：① 在提交路径维护该列；② 再加回检查。只做②会重新踩坑。

### 4.4 评论发布曾"读在事务外"（真实竞态）

评论发布最初写在 `src/worker/handlers.ts` 里，**先读后写、读在事务外** —— 资格核验与写入之间
若有并发删除，**已删除的评论仍会被公开**。已迁到 `src/server/workflows/publish-comment.ts`，
资格核验全部移进 `withTransaction`（与 `publishReview` 同构）。新增 4 条 workflow 测试锁住语义。

### 4.5 其他踩过的坑（简要）

| 坑 | 现象 | 修法 |
|---|---|---|
| `__test__` 目录 | 路由 404 | Next 把 `_` 前缀当私有 → 改名 `testing` |
| `__Host-` Cookie | 登录 200 但立刻匿名 | `__Host-` 要求 `Secure`，http 下被丢弃 → dev 用 `dsh_session_dev` |
| `POST /api/drafts` 身兼两职 | 保存请求被当新建，**静默返回未保存的草稿** | 拆 POST/PUT/PATCH |
| 评测未绑定插件仍可保存 | 保存得了、提交必被拒（`plugin_id` 是 NOT NULL 外键） | 这是产品规则；入口只能在插件页（§1.2 第 14 条） |
| 未公开评论出现在公开列表 | **真实漏洞**，泄露待审内容 | 三处补 `published_revision_id IS NOT NULL` |
| `acceptance-upload.mjs` 写死 UUID | 第二次运行撞 UNIQUE | 改为每次新建 ID（仓库/插件按稳定键复用） |
| 管理员决定路由无动态段 | 500 | 移到 `.../[submissionId]/decisions` |
| `fs.cpSync` 遇 CJK | `0xC0000409` 崩溃 | 见 `docs/环境坑-cpSync-CJK崩溃.md`（本项目路径含 CJK） |
| 验收脚本共享 cookie jar | 断言被前一步登录污染 | 每角色独立 jar |
| 登出后页面不刷新 | 点「登出」后，已渲染的服务端页面仍显示登录态操作（如插件页的「写一篇评测」） | 这是 Next 的 Router Cache；**硬刷新即正确**（刷新后显示"登录后可以在这里写评测"），且服务端照样会 401 拦住。暂未处理 |

---

## 5. 浏览器点击链路的证据

### 5.1 环境与工具

- dev server：`http://127.0.0.1:3100`（`next dev`，进程号会变，用端口判断）
- worker：`DSH_REVIEW_CONTENT_SCREEN=basic npx tsx src/worker/main.ts`
- 浏览器工具：`browser_session start` → `browser_page navigate` → `browser_inspect observe` → `browser_interact`

### 5.2 一次完整点击（2026-10-12）

| # | 操作 | 观察到的结果 |
|---|---|---|
| 1 | 插件目录 → `deepseek-ai/deepseek-harness / packages/bundle/base` | 详情页出现「写一篇评测」 |
| 2 | 点「写一篇评测」 | 新草稿 `01a12f6a-fe61-7fa9-a29b-8fe7c8f027de`，保存版本 0，顶部显示「关联插件：`01a12ac1-…`」 |
| 3 | 填标题与正文 → 点「保存」 | 保存版本 0 → 1 |
| 4 | 点「提交审核」 | 先自动保存（1 → 2）再提交：`01a12f6b-2e08-…`，状态 `pending`（未假装已发布） |
| 5 | 不干预，等 worker | 日志：`review_check` → `approved` → `review_publish` → **评测已发布** |
| 6 | 打开 `/me` | 提交记录显示**已发布** |
| 7 | 打开 `/reviews/01a12f6a-fe60-7e51-8048-daa5985c610f` | 正文渲染、结构化版本栏、评论框可用 |
| 8 | 输入评论 → 点「发表评论」 | 提示"评论已提交，正在等待检查"；worker 随后 `comment_publish` → **评论已发布** |
| 9 | 刷新公开页 | 「评论（1）」出现该评论 |
| 附加 | 点「登出」→ 刷新插件页 | 显示"登录后可以在这里写评测"（未登录分支正确） |

**没点到的**：图片「插入图片」（系统文件选择器）。

**操作注意**：`browser_interact` 的 `click` 只能带**一个** `target`，别把解释文字塞进同一个调用块。
评论框这类没出现在 a11y 树里的元素，可以用 CSS 选择器（`#comment-<contentId>`）直接填。

---

## 6. 仓库与提交

- 工作目录：`D:\developing\ds民间科研成果展示\插件测评网站`
- 远程：`origin https://github.com/furongjun-lingshu/dsh-plugin-reviews.git`（**PRIVATE**）
- 提交历史：`5d717ab`（切片）→ `e59a71a`（README dev.cmd 说明）→ **`938f32a`（本轮收口，已推送）**
- 推送方式（**未持久化到全局配置**）：
  ```
  git -c credential.helper="!gh auth git-credential" push
  ```
- `gh` CLI 已认证为 **liceses**（仓库属主是 furongjun-lingshu，但 liceses 有推送权限 —— 实测推送成功）
- `.data/`、`.env.local` 已在 `.gitignore`；提交前用 `git status` 过一遍

---

## 7. 环境与凭据

### 7.1 运行时

- Node **v24.12.0**（文档目标 24.21.0 —— 已记录的偏离，未在 24.21.0 上验证）
- `core.autocrlf=true`；`dev.cmd` 用 CRLF + 无 BOM（`.gitattributes` 已锁 `*.cmd text eol=crlf`）
- 全局规则见 `~/.dsh/AGENTS.md`（破坏性命令红线、`$HOME` 只读、备份纪律）—— **动手前读**

### 7.2 ⚠️ 本机沙箱下 `pwsh` 会崩（2026-10-12 实测）

DSH 文件策略为 **workspace-write** 时，`pwsh` 工具**每个命令**都以 `0xC0000142`
（`STATUS_DLL_INIT_FAILED`）失败，`pwsh -Command` 连 `echo` 都跑不起来 —— 不是命令的问题，是 shell 起不来。
本轮会话中途主人把策略改成 **danger-full-access**，`pwsh` 立刻正常。

**接手时先确认当前文件策略**：若还是 workspace-write 而 `pwsh` 报 0xC0000142，
要么请主人放宽策略，要么改用 `posix` 工具（插件自带、纯 JS、但**只读**，只能 ls/cat/grep/find/head/tail/wc/pwd/echo）。
`blender_rt_*` 那套工具依赖本机 Blender addon（127.0.0.1:9876），当时未连接，帮不上忙。

### 7.3 `.env.local`（**已被 gitignore**，不随仓库走）

当前内容（值已脱敏）：

```ini
DSH_REVIEW_DB_PATH=.data/app.sqlite
DSH_REVIEW_ALLOW_TEST_LOGIN=1      # 测试登录通道（仅非生产 + 显式 1）
DSH_REVIEW_CONTENT_SCREEN=basic    # 让提交能自动发布（默认空=停在 manual_review）
GITHUB_TOKEN=***                   # 收录探针用，提高限额 60→5000 次/小时
```

`GITHUB_TOKEN` 取自 `gh auth token`（40 字符 `gho_` 前缀）。**不要把 token 写进任何被跟踪的文件。**

### 7.4 待主人提供

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（建 OAuth App 才有）→ 真实登录
- `SESSION_SECRET`（≥32 字节）→ **生产必须**，否则服务端拒绝发起登录（避免明文存 PKCE verifier）

---

## 8. 架构与文件地图

```
migrations/            0001_baseline / 0002_triggers / 0003_auth_media
                       —— 25 表 / 18 触发器，**权威结构**（不是 Drizzle schema）
src/packages/common/   错误码、结果与分页、字段规则、状态文案（浏览器可用）
src/server/platform/   db / tx / time / id / digest / log / context / migrate /
                       errors-http / request-id / session-cookie / file-store / markdown
src/server/modules/    identity · catalog · reviews · content · comments ·
                       moderation · tasks · operations · media
src/server/workflows/  submit-review · publish-review · publish-comment（跨模块协调事务）
src/server/adapters/   login（真实 GitHub OAuth + 测试通道）· catalog（真实 api.github.com 探针）
src/app/               App Router：页面 + /api 路由
src/components/        session-nav · plugin-submit-form · review-editor · comment-section ·
                       start-draft-button · api-client
src/worker/            main（独立进程）· handlers（4 处理器）· content-screen（本地基础筛查）
tests/                 16 文件 / 357 测试（用真实临时库 + 真实迁移，**不用 `:memory:`**）
scripts/               验收与自检脚本
docs/                  设计映射、并行分组协议、模块签名契约、验收纪律、环境坑
```

### 8.1 关键 API 契约（**别猜，以代码为准**）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/session` | 会话状态 + `githubLoginConfigured` + `testLoginEnabled` |
| `DELETE /api/session` | 登出（**登录 POST 已移除**） |
| `GET /api/auth/github/start` | 302 到 GitHub；未配置 → 503 HTML |
| `POST /api/testing/session` | 测试登录（需 `DSH_REVIEW_ALLOW_TEST_LOGIN=1` 且非生产） |
| `POST /api/drafts` | 新建/复用草稿：`{requestKey, pluginId}` → 201（**pluginId 决定评测归属，别传 null**） |
| `PUT /api/drafts` | 保存：`{draftId, requestKey, expectedVersion, title, pluginId, pluginVersion, dshVersion, body[]}` |
| `PATCH /api/drafts` | 提交：`{draftId, requestKey, expectedSaveVersion, title, bodyMarkdown, pluginVersion, dshVersion}` → 202 |
| `GET /api/drafts?draftId=` | 读草稿 |
| `POST /api/drafts/{draftId}/attachments` | 登记附件：`{originalFilename, usage}` → `{attachmentId}` |
| `PUT /api/attachments/{id}/file` | **原始字节**，`content-type: image/png\|jpeg\|webp`，≤10MB |
| `GET /media/{attachmentId}/{variantKey}` | `DISPLAY`（公开引用后）/`ORIGINAL`（不公开） |
| `GET\|POST /api/content/{contentId}/comments` | 评论列表 / 发表（**不是** `/api/comments`） |
| `GET /api/reviews/{reviewId}` | 公开详情（未公开 → 404 且不返回正文） |
| `POST /api/reviews/{reviewId}/withdraw` | 作者撤回，需 `expectedControlVersion` + `requestKey` |
| `GET /api/plugins` / `POST /api/plugins` | 列表 / 收录（真实探针）；不存在的仓库 → **400**，不是 503 |
| `GET /api/admin/submissions` | 待办列表 |
| `POST /api/admin/submissions/{submissionId}/decisions` | 人工决定 |

**版本字段形状**：`{kind:'unknown'}` 或 `{kind:'known', value:'1.2.3'}`。
空值不是"省略"，而是**明确选未知** —— 未知**不是**退回理由（产品规则）。

**页面入口**：写评测只能从 `/plugins/{pluginId}`（插件详情页）发起 —— 评测必须绑定插件。
`/me` 只做引导，不再建无插件的死草稿。

---

## 9. 测试与验收纪律（**这个项目的核心价值，别丢**）

1. **反同义反复（anti-tautology）**：每个关键测试都要能被"破坏实现"咬红。
   项目里有 `scripts/verify-*-bite.mjs` 系列，做法是：破坏实现 → 断言测试变红 → **按字节还原** → 断言复绿。
   **"第一次就全绿"通常意味着变异脚本本身没生效**。改断言时也一样：本轮把验收脚本的收录断言改成
   动态口径后，专门用**变异副本**（URL 换成真实插件 → 201 成功）验证了它会变红。
2. **真实临时文件库 + 真实迁移**，**禁止 `:memory:`** —— 内存库测不出触发器与迁移问题。
3. **禁止恒真断言**（如 `expect(x).toBeDefined()` 当唯一断言）。
4. **单测测不出的东西，靠真进程**：handlers 空注册表、评论发布读在事务外、
   `runRuleCheck` 的 snapshot 不含正文 —— 这三个都是**单测全绿但真跑才暴露**的。
5. **HTTP 验收测不出的东西，靠真的去点**：本轮第 14 条（缺绑定插件入口）就是这样咬出来的。
6. **验收脚本必须可重复运行**，且**不假设库为空**。

---

## 10. 给接手者的最短路径

```cmd
cd /d "D:\developing\ds民间科研成果展示\插件测评网站"
npx tsc --noEmit                 REM 期望 exit 0
npx vitest run                   REM 期望 357 passed / 16 files
dev.cmd                          REM 迁移 + 自检 + 起 Web（3100）
REM 另开窗口：
set DSH_REVIEW_CONTENT_SCREEN=basic
dev.cmd worker                   REM 要真正发布内容就需要它
dev.cmd accept                   REM 读/写/上传/端到端 四段验收（跑之前先停掉常驻 worker）
```

然后：读 §3 挑一件做 —— 要么请主人给 OAuth 密钥把真实登录跑通，
要么把 §3.2 里某条"未做"补上（后台审核页面 / 修订历史界面 / 搜索 是最顺手的三个）。
