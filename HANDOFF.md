# 交接书 · DSH 插件测评网站

> 2026-10-12（第三轮会话收尾）。上一版交接书的内容已并入本文件，旧的过时条目已直接改掉。
> **目的**：让接手的人（或下一个会话的我）不必依赖上一轮的记忆，只看本文件 + 仓库就能继续。

---

## 0. 一句话状态

**核心链路已实现、真机验证、逐页点通**：
登录 → 收录插件 → **从插件页写评测** → 保存 → 提交 → **检查/人工审核** → **真 worker 发布** → 公开可读
→ 评论 → **回复** → 作者**撤回**；新用户落地页 `/onboarding` 可用。

`tsc` exit 0、单测 **418/418（22 文件）**、HTTP 验收 **16 + 21 + 14**、端到端 **22/22**，
浏览器点击链路两轮共 22 步（§5.2 / §5.3）。
**已提交并推送：`938f32a`（第二轮）→ `c8c4138`（交接书）→ 第三轮见 §6。**

**真实 GitHub 登录已跑通一次完整往返**（2026-10-12 晚，真账号 `liceses`、真 OAuth App、真授权页）——
在此之前它只验到"未配置时明确 503"。见 §5.4。**主人自己的账号 `icelily` / `01a130c1-…` 已是管理员。**

**已部署到一台 Linux VPS 并在线上又跑通一次真实登录**（2026-10-13）：
**http://5.231.26.36** —— web + worker 双 systemd 常驻、跑在 `dsh` 用户下、全新空库
（因此 `BOOTSTRAP_ADMIN_GITHUB_ID` 真的生效，第一次登录即管理员）。步骤与坑见
[deploy/README.md](deploy/README.md)。**仍是 HTTP、没有备份、没上域名**。

**第三轮补掉的是"页面上的洞"**（§1.2 第 16、17 条）：后台审核按钮、作者撤回按钮、评论回复、
`/onboarding`、首个管理员指定方式 —— 以及一个真正的断点：**人工通过之后没有任何东西去发布**。

**当前没有待办的技术债**；剩下的都是"要么等主人给密钥/域名，要么本来就在切片范围外"（§3）。

---

## 1. 这三轮做了什么

### 1.1 第二轮（提交 `938f32a`）：把第一轮写好的东西验到底

- 真实 GitHub OAuth（PKCE S256 + state 摘要 + 浏览器绑定 Cookie + 一次性消费）
- 真实 api.github.com 收录探针（`POST /api/plugins` 原先永远是 503 的桩）
- worker 的 4 个处理器（原先 handlers 注册表是**空 `{}`**）
- 图片上传全链路、Markdown sanitize 渲染、5 个前端组件 + 2 个页面、作者撤回
- `next.config.ts` 的 `allowedDevOrigins`

### 1.2 第二轮**新发现并修掉**的两个真缺陷

| # | 缺陷 | 怎么发现的 | 修法 |
|---|---|---|---|
| 14 | **评测没有"绑定插件"的入口**：插件详情页（设计文档指定的入口）没挂按钮，`/me` 的「写一篇评测」却建出 `plugin_id` 为空的草稿 —— 它能保存、能显示，**一点提交就报"请选择插件"**，而界面上没有任何办法补救 | **人工浏览器点击链路**。HTTP 验收与 357 个单测**全都没碰到这一层**：它们一律直接从 API 带 `pluginId` 建草稿，所以咬不出来 | 插件详情页挂 `StartDraftButton pluginId={plugin.pluginId}`；`/me` 改成引导到插件目录；编辑器顶部明示「关联插件」或「未关联 → 无法提交」 |
| 15 | `acceptance-http.mjs` 的收录断言**过时**：写死要求 `503` | 跑全量验收读出 **15/16**。查因：探针接真实 api.github.com 之后，不存在的仓库**本就该**返回 `400`（`input_invalid` + 具体原因），`503` 只是探针还是桩时的口径 | 改成"明确拒绝且不假装成功"（400/503 + 错误码白名单 + `ok=false`）；再用**变异副本**把 URL 换成真实插件目录（→ 201 成功）验证它会变红 |
| 16 | **管理员点"通过"之后没有任何东西会去发布**：`decideByAdmin` 把状态推到 `approved` 就结束了。当时页面上连审核按钮都没有，就算有，按了也不会公开 | 第三轮做后台审核按钮时**读代码**发现的。两个验收脚本都在"通过"之后**直接调用 `publishReview`**，正好把这条缝盖住（与"handlers 空注册表"同一类：验收脚本代替了真实路径） | 新增 `workflows/decide-submission`：决定 + **按提交类型**入队发布任务（评测 → `review_publish`，评论 → `comment_publish`）。子缺陷：一律入队 `review_publish` 的话，被通过的**评论**会静默地永远发不出去 —— 这是浏览器里真踩出来的（点通了评论的"通过"，评论却不出现在讨论组里） |
| 17 | **一批"接口都有、页面没有"的半截功能**：① callback 对新用户 302 到 `/onboarding`，而**这个页面根本不存在**（真实 OAuth 新用户一登录就 404）；② `identity.updateProfile` 实现了却**没有路由**；③ `commentsService.listReplies` 实现了却**没有路由**（只能看到"3 条回复"这个数字，点不开也回不了）；④ 作者撤回只有 API | 逐页清点"用户能点的地方"（列清单逐条对，不是读代码猜） | 补 `/onboarding`（含 `returnTo` 开放重定向防护）+ `PATCH /api/me/profile` + `/api/content/{id}/comments/{cid}/replies`（补内容可见性与归属核对）+ 作者撤回按钮（两段确认）+ 评论回复 UI + `scripts/grant-admin.mjs` |

> 第 14 / 16 / 17 条都指向同一件事：**"接口全对、页面走不通"这类缺陷，只有真的去点才会暴露。**
> 而第 16 条更狠 —— 它连"点"都没露出来，是**读代码**读出来的：验收脚本替它把活干了。

### 1.3 第三轮新增的文件（都在 §8 代码地图里）

| 文件 | 作用 |
|---|---|
| `src/server/workflows/decide-submission.ts` | 人工审核决定 + **按提交类型**入队发布任务（第 16 条的修法） |
| `src/components/admin-decision-form.tsx` | 后台「通过并发布 / 需修改」表单（原因必填、幂等键、如实报告入队结果） |
| `src/app/onboarding/page.tsx` + `src/components/profile-form.tsx` | 新用户落地页 + 资料确认（第 17 条①） |
| `src/app/api/me/profile/route.ts` | `PATCH` 保存昵称（接上早就写好却没路由的 `updateProfile`，第 17 条②） |
| `src/app/api/content/[contentId]/comments/[commentId]/replies/route.ts` | 组内回复分页（第 17 条③，补内容可见性 + 归属核对） |
| `src/components/withdraw-button.tsx` | 作者撤回按钮（第 17 条④，两段确认） |
| `scripts/grant-admin.mjs` | 指定/撤销管理员（首个管理员没有界面入口，见 §3.1） |
| `tests/decide-submission.test.ts` | 5 个用例：人工通过必须入队、评论提交必须入队 `comment_publish`、needs_changes 不入队、非管理员被拒 |

### 1.4 第四轮：插件目录补全 + 选型调查（`docs/技术选型-基础功能用库还是自己写.md`）

| 文件 | 作用 |
|---|---|
| `migrations/0005_plugin_directory_info.sql` | 给 `repositories` / `plugins` 补展示列（简介、topics、owner、头像、仓库更新时间、清单名/作者/版本、`info_updated_at`）+ 浏览序索引 |
| `src/packages/common/time.ts` | 固定 `Asia/Shanghai` 的时间格式化（修掉线上差 8 小时） |
| `src/app/plugins/page.tsx`（重写） | 搜索框、标签 chip、是否有评测、排序、分页、**两种空状态**、越界页、提交入口 |
| `src/app/page.tsx`（重写） | 首页三块齐全：搜索入口 + 最新评测（带插件名）+ **近期更新插件**；删掉"搜索见插件目录"的空话 |
| `src/server/modules/catalog/service.ts` | `listPlugins` 支持 q/tag/hasReviews/sort 与**真实总数**；`listPluginTags`；公开评测计数与可见性判据**共用同一段 SQL** |
| `tests/catalog-browse.test.ts` | 12 条：搜索（含 `%`/`_` 转义）、标签、评测三态、**撤回后计数与筛选同步**、分页同 `updated_at` 不重不漏、标签聚合、坏数据 |
| `tests/support/probe.ts` | 探针桩构造器（契约加字段后，测试不必每个桩手写一堆 null） |
| `scripts/backfill-plugin-info.mjs` | 存量条目回填（幂等重跑收录检查；默认 dry-run） |
| `scripts/acceptance-catalog-browse.mjs` | 目录浏览 HTTP 验收（10 条，不假设库里数据量） |

### 1.5 第五轮：请求频控（主人在"下一步"里选了先做频控）

| 文件 | 作用 |
|---|---|
| `migrations/0006_rate_limiter.sql` | 频控计数表（DDL **照抄** rate-limiter-flexible 自建的那份；库用 `tableCreated:true` 不再自建） |
| `src/server/platform/rate-limit.ts` | `RATE_LIMIT_RULES`（5/分、10/时，逐字对应规格）+ `enforceRateLimit` / `refundQuietly` / `peekRateLimit`；limiter 按 (db × 动作) 缓存，用 WeakMap 以免串库 |
| `src/app/api/plugins/route.ts` | 收录前先 `assertCanWrite` + 限流（**先限流再出网探测**），`replayed` 时退还 |
| `src/app/api/content/[contentId]/comments/route.ts` | 评论唯一写入口，挂 `comment_change`；`created===false`（重放）时退还 |
| `src/server/modules/comments/index.ts` | 修掉一处真 bug：最终 return 丢了 `created`，导致"重放退还"会静默失效（tsc 报出来的） |
| `tests/rate-limit.test.ts` | 13 条：规则防漂移、表结构与库期望一致、并发不超发、过期重置、退还、误用保护 |
| `scripts/acceptance-rate-limit.mjs` | 真 HTTP 验收 12 条（重放不占额度 / 同键换正文 409 / 第 6 次 429 + 等待秒数） |

---

## 2. 验证状态（**都是真跑出来的数字，附复现命令**）

| 项目 | 结果 | 复现命令 |
|---|---|---|
| 类型检查 | **exit 0** | `npx tsc --noEmit` |
| 单元/集成测试 | **418 passed / 22 files** | `npx vitest run` |
| HTTP 读验收 | **16/16**（连跑两次都一样） | `node scripts/acceptance-http.mjs`（需 dev server） |
| HTTP 写验收 | **21/21** | `npx tsx scripts/acceptance-http-write.mjs` |
| 图片上传验收 | **14/14**（可重复运行） | `npx tsx scripts/acceptance-upload.mjs` |
| **端到端整条链** | **22/22** | `npx tsx scripts/acceptance-e2e-chain.mjs` |
| 浏览器点击链路 | 第二轮 **9 步** + 第三轮 **13 步**（人工） | README-切片说明.md §5.2 / §5.3 |
| 人工审核 → 自动发布 | 通过（任务 ID 与 worker 日志对得上） | README §5.3 第 4—6 步 |
| 真实 GitHub 收录 | 成功收录 `packages/bundle/base` | 见 §5.1 |
| 浏览器真登录（测试通道） | 导航栏变为真实用户 ID + 登出 | 见 §5.2 |
| **真实 GitHub OAuth 往返** | **通过**（真账号 `liceses` → 授权 → 回调建号 → onboarding → 提为管理员） | 见 §5.4 |
| **线上部署（Linux VPS）** | **通过**：http://5.231.26.36 ，web+worker 双 systemd，真机登录后 `users=1 role=admin` | 见 [deploy/README.md](deploy/README.md) |
| 凭据预检（假 code 换 token） | `bad_verification_code`（= 凭据配对正确） | 见 §5.4 第 3 步 |
| **健康检查 `/api/health`** | **通过**（16 条新测试）：结构坏了 503、公网 body 不含逐项检查、`?worker=1` 才把 worker 算进结论 | `tests/health.test.ts` |
| **worker 运行时心跳** | **通过（正反两向真跑）**：worker 起来后心跳新鲜、`diagnose` 显示 ok；停掉且阈值压到 1 秒 → 判 dead、退出码 1 | `migrations/0004`、`scripts/worker-healthcheck.mjs` |
| **访问日志（每请求一行，含状态码与耗时）** | **通过**：生产下打出 `http_request` 行（200/404/400 都验过），`/api/health` 与 `/_next/*` 静音；`request_id` 与响应头/响应体**同一个号** | `server.mjs` + `tests`… 见 §4.5 相关坑 |
| **未捕获异常链路（digest 闭环）** | **通过**：故意抛异常的页面 → HTTP 500 → `request_error` 日志含 `path`/`digest`/`stack`，用户错误页上显示**同一个** digest（浏览器实测） | `src/instrumentation*.ts`、`src/app/error.tsx` |
| **中文 404 / 错误页** | **通过**：404 页含中文说明、三个入口与本次 `request_id`；错误页含 digest、重试、回首页 | `src/app/not-found.tsx`、`error.tsx`、`global-error.tsx` |
| **线上已带可观测性** | **通过（2026-10-13 21:22 重启后实测）**：线上 `/api/health` 200 `schema 0004`、访问日志 `http_request` 有行、启动自检有行、worker 心跳 3 秒前、中文 404 生效、无 error 级日志 | `deploy/README.md` §当前线上状态 |
| **插件目录：搜索 / 筛选 / 排序 / 分页** | **通过**：搜索命中名称·仓库·简介三字段；`q=%` 与 `q=_` 得 **0 条**（转义生效，不匹配全表）；标签筛选、`has_reviews` 三态、两种空状态文案不同、越界页单独提示、未知 id → 404 | `tests/catalog-browse.test.ts`（12 条）+ `node scripts/acceptance-catalog-browse.mjs`（**10/10**，对运行中的服务发真请求） |
| **目录卡片真实资料（迁移 0005）** | **通过（真 GitHub）**：回填 `deepseek-ai/deepseek-harness / packages/bundle/base` 后，库里真有 `display_name=@deepseek-ai/dsh-base`、`manifest_version=0.2.1-alpha.2`、`topics=["ai-agents","cordis","dsh","dsh-plugin"]`、owner 头像 URL、仓库更新时间 | `npx tsx scripts/backfill-plugin-info.mjs --apply`，结果见 README §验收脚本 |
| **时区修正** | **通过**：全站时间改用固定 `Asia/Shanghai` 格式化（原先用 `toLocaleString('zh-CN')` = 服务器本地时区，线上 UTC 会**整体差 8 小时**） | `src/packages/common/time.ts`，7 处调用点已替换 |
| **请求频控（迁移 0006）** | **通过**：评论变更 5/分/用户（合并计数）、插件提交 10/时/用户；超限 **429 + `retry_after_seconds`**；**同键同内容重放不占额度且返回原结果**；同键换正文给 409；并发 20 次恰好放过 5 次 | `tests/rate-limit.test.ts`（13 条）+ `npx tsx scripts/acceptance-rate-limit.mjs`（**12/12**，真 HTTP） |
| **频控已上线上（2026-10-13 22:29）** | **通过（能验的部分）**：`/api/health` → `schema_version 0006_rate_limiter.sql`；`selfcheck` → `missingTables: []`、`problems: []`；三个页面 200；近 200 行日志 **0 条 error**。**未验**："打满 6 次拿 429" 需真人登录（生产关掉了测试登录通道）| `deploy/README.md` §当前线上状态 |

端到端脚本覆盖：登录 → 会话接口 → 收录真实插件 → 建草稿 → 保存 → **过期版本被拒** → 提交(pending)
→ **真 worker 进程** → `published` → 公开修订指针切换 → 匿名可读 → 发评论 → worker 发布
→ 出现在公开列表 → **发回复 → worker 发布 → 从组内回复路由读到 → 计入 replyCount → 用回复 ID 当讨论组被拒**
→ 登出 → 登出后写操作 401。

> ⚠️ 跑 `acceptance-e2e-chain.mjs` 之前**必须先把常驻 worker 停掉**：脚本要自己起 worker，
> 并且会断言**自己那个子进程**的 stdout（`handler_count`）。两个 worker 会抢任务，脚本会误报失败。
> 另注：直接用工具 kill 后台作业时，**tsx 的子进程可能不跟着死**，记得确认 `node.exe` 里没有
> `src/worker/main.ts` 残留。

---

## 3. 未完成 / 下一步

### 3.1 需要主人动手（我做不了）

1. ~~**真实 GitHub 登录生效**~~ ✅ **已完成（2026-10-12 晚，本机）**：App `dsh-plugin-review-dev`，
   callback `http://127.0.0.1:3100/api/auth/github/callback`，`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
   已填进 `.env.local`，真账号 `liceses` 走完授权 → 回调 → 建号 → `/onboarding`，见 §5.4。
   **剩余**：生产域名 / HTTPS / 反代下的回调**没验过** —— GitHub 每个 App 只允许填**一个** callback URL，
   换域名时要改这一处或另建一个 App。生产还要把 `SESSION_SECRET` 换成新生成的（现在这个是本机跑用的）。
   > 记性：三个变量 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_REDIRECT_URI` **都必填**
   > （`redirect_uri` 没有默认值，漏了照样判"未配置"），缺任一个 `/api/session` 的
   > `githubLoginConfigured` 就是 `false`。Next dev 会**自动重载** `.env.local`（日志 `Reload env: .env.local`）。
   > 配完先跑 `node scripts/check-github-oauth.mjs`：它检查三项是否齐全，并拿一个**假 code** 去换 token ——
   > GitHub 回 `bad_verification_code` 就说明**凭据配对正确**（凭据错会回 `incorrect_client_credentials`），
   > 于是不用点进去才发现配错。脚本不打印任何密钥；两条负路径都实测咬得动（错 secret → 退出码 1）。
   > ⚠️ 它用 `process.exitCode` 而不是 `process.exit()`：后者在本机会撞 libuv 断言（`0xC0000409`）。
2. 可选：`GITHUB_TOKEN`（`gh auth token` 的输出）把收录探针限额 60 → 5000 次/小时。
3. **首个管理员**（站内没有提权入口，这是刻意的），两条路：
   - **部署配置引导（推荐，第一次登录就生效）**：`.env.local` 里
     `BOOTSTRAP_ADMIN_GITHUB_ID=<你的 GitHub 数字 ID>`（`gh api user --jq .id`）。
     语义是**引导**：只有当库里**一个可用管理员都没有**时才提升 ——
     被降过权的账号不会在下次登录时自己变回来。
     > 本机这次它**没有**生效（库里已有 10 个验收留下的管理员），这是设计如此；最后是用下面第 2 条提的。
   - **上机指定/撤销**（账号得先登录过一次）：
     ```cmd
     node scripts/grant-admin.mjs --list
     node scripts/grant-admin.mjs --github-login <你的 GitHub 账号>
     ```
     `--revoke` 在会把最后一个可用管理员降级时拒绝执行。
4. **准备给真人用之前**（现在都还开着，仅供本机验收）：
   - `DSH_REVIEW_ALLOW_TEST_LOGIN=1` → 任何人点「测试登录」就能凭空造身份，**能连上站就等于谁都能进来**。
   - `DSH_REVIEW_CONTENT_SCREEN=basic` → 只是本地词表，会**自动放行**；生产该留空走人工，或接真审核。
   - 本机 `.data/app.sqlite` 里全是验收垃圾（50 个账号、10 个管理员）；要干净起步就换一个新路径跑迁移（**别删旧库**）。

### 3.2 明确未做（**不要当成已完成**）

| 未做 | 说明 |
|---|---|
| 目录发现 / 定时同步 | 只有"粘链接自助收录"；架构 §92—99 的发现与同步未做 |
| 真实外部内容审核 | 内置的只是**本地确定性基础筛查**（词表+长度+刷屏），**不是审核服务**；默认还关着 |
| 站内管理员授予/撤销界面 | 只有 `scripts/grant-admin.mjs`（上机执行）。举报、纠错处理、操作记录查看都没有 |
| 修订历史界面、搜索筛选 | 快照在库里，但没有读取界面；列表只分页 |
| 多 patch 数组完整核验 | 契约返回单个 `bundlePath`，只核验第一条（见 §4.1） |
| 评论编辑 | 因此评论发布**没有** `superseded` 检查（见 §4.3） |
| Linux/Docker 构建、备份恢复演练 | 只验证了本机 Windows + Node 24 |
| 浏览器自动化 | 无 Playwright；点击链路是**人工**点过两轮，**回归时不会自动重跑** |
| 图片「插入图片」按钮 | 系统文件选择器工具驱动不了，没被浏览器驱动验证过（只验了 HTTP 契约 14/14） |
| 列表页翻页 | `/reviews` 是整表取出再逐条算可见性（没有分页也没有上限）；`/plugins` 只渲染第一页 |

### 3.3 想继续时的最短路径

```cmd
cd /d "D:\developing\ds民间科研成果展示\插件测评网站"
npx tsc --noEmit                 REM 期望 exit 0
npx vitest run                   REM 期望 418 passed / 22 files
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
| 验收脚本写死幂等键 | 第二次运行撞 `request_key_reused(409)`（幂等机制是对的，脚本不可重复） | 每次运行生成唯一键（`RUN = Date.now().toString(36)`） |
| **`.env.example` 里的变量没人读** | 部署者照填，然后什么都不会发生（`BOOTSTRAP_ADMIN_GITHUB_ID`、`SITE_ORIGIN`） | 前者已接上（§1.2 第 18 条）；后者如实标注"当前未读取"。**加配置项时同时加读者，或标注它还是空的** |
| **生产构建跑在 http 上 → 会话立刻丢失** | 生产用 `__Host-` + `Secure`，浏览器只在 HTTPS 下收；表现为"登录 200，下一次请求变匿名"。OAuth 的浏览器绑定 Cookie 同样会丢（回调时报绑定失败） | 新增 `DSH_REVIEW_INSECURE_COOKIES=1` 显式降级（`resolveCookieMode` 纯函数，两条写 Cookie 的地方共用一个 `cookieSecure()`），启动打警告。上 HTTPS 后必须删掉 |
| **Client ID 抄错一个字符，GitHub 只回 404** | `POST /login/oauth/access_token` → `HTTP 404 {"error":"Not Found"}`（不是 `incorrect_client_credentials`）。把截图里的 `…TSkl` 看成了 `…TSk1`（小写 L / 数字 1） | 用 `node scripts/check-github-oauth.mjs` 判定：`bad_verification_code` = 凭据与回调都对；`Not Found` = 这个 client_id 它不认识。**抄 id/secret 一律用复制按钮，不要看图打** |
| 登出后页面不刷新 | 点「登出」后，已渲染的服务端页面仍显示登录态操作（如插件页的「写一篇评测」） | 这是 Next 的 Router Cache；**硬刷新即正确**（刷新后显示"登录后可以在这里写评测"），且服务端照样会 401 拦住。暂未处理 |
| **`npm ci` 在 `NODE_ENV=production` 下不装 devDependencies** | 容器构建时 `tsx`（worker 运行时）与 `typescript`（构建）都在 dev 里 → 构建失败或 worker 起不来 | Dockerfile 里显式 `npm ci --include=dev`，并在注释里写清为什么 |
| **测试里 `getDb()` 单例占着临时库，Windows 删不掉目录** | 用例全绿但**文件级**失败：`EPERM ... dsh-review-test-xxxx`，很容易被"Tests 418 passed"那行糊过去 | 该 describe 的 `afterAll` 里先 `closeDb()` 再 `cleanup()` |
| **`Start-Process npx` 在 Windows 起不来** | 报"不是有效的 Win32 应用程序"（npx 是 .cmd 垫片） | 后台跑用 `cmd /c npx ...`，或直接用作业层 |
| **诊断脚本查任务队列用了想当然的列名** | 我按 `status` / `error_code` 写，真表是 `processing_state` / `last_error_code`；更糟的是 `try/catch` 把错误吞了，输出只留一个 `运行中 ?` | 列名一律回迁移里核对；诊断脚本自己也要把"读失败"打出来（已改：`out.tasks.error` 会进结论） |
| **Next 自带的访问日志在生产下不生效** | `logging.incomingRequests` 只在 dev 打；中间件又拿不到最终状态码 → 生产日志里"哪个接口 500、哪个页面慢"完全看不见 | 用自定义 server（`server.mjs`）包一层，打 `http_request` 行；`npm start` 与容器 CMD、systemd 单元都指向它 |
| **访问行的 request_id 与响应体里的对不上** | 自定义 server 自己生成一个 id 放进响应头，业务层 `requestIdFromHeaders` 又生成另一个 → 用户报的编号 grep 不到那一行 | server 里把 id **注入入站请求头**（`req.headers['x-request-id']`），业务层就会沿用；实测三处同一个号，且外部带 id 进来也会沿用 |
| **`_` 前缀的 App Router 目录不参与路由** | 临时验证页放在 `src/app/__boom/`，请求它得到 404（Next 把 `_` 前缀当私有文件夹） | 验证类页面别用下划线前缀（改成 `boom-verify` 后立即命中 500） |
| **`instrumentation.ts` 会被同时编到 Edge 运行时** | 在同文件里动态 import 业务模块 → 构建打出 7 条 "A Node.js API is used ... not supported in the Edge Runtime" 警告（`process.stderr`、`process.pid`、better-sqlite3） | 拆成 `instrumentation.ts`（只留正条件判断 + 动态引入）+ `instrumentation-node.ts`（真正实现），警告清零 |
| **`sharp` 被直接 import，却只靠 Next 的可选依赖活着** | `media/service.ts` 直接 `import sharp`，而它原先只是 `next` 的 `optionalDependencies`；换 pnpm（严格 node_modules）或 `npm ci --omit=optional` 会让**图片上传直接炸** | 在 `dependencies` 里显式声明 `sharp`（精确固定版本）；Next 的默认外置清单本来就含 sharp，实测 Turbopack 构建照过 |
| **声明了却零引用的依赖会误导后来人** | `zod` 与 `drizzle-orm` 在 `src/`、`tests/`、`scripts/` **全仓 0 引用**，但留在依赖里会让人以为存在校验层 / ORM 层 | 已 `npm uninstall`；选型结论与复核命令写进 [docs/技术选型-基础功能用库还是自己写.md](docs/技术选型-基础功能用库还是自己写.md) |
| **验证时打到了上一轮遗留的旧服务器** | 端口 3200 被上一轮的 `next start` 占着（我这轮的 `node server.mjs` 报 `EADDRINUSE` **被我忽略**），于是所有"页面验证"其实验的是**旧构建**：新加的空状态逻辑一个都没生效，差点被当成"实现有问题" | 验证前先确认端口上是谁：`Get-NetTCPConnection -LocalPort N` + `Get-CimInstance Win32_Process` 看命令行；确认是自己的旧实例再停掉，换端口用**本次构建**重跑 |
| **SSR 输出在插值处插了 `<!-- -->`** | 用 HTML 文本做断言时，`共 {total} 个条目` 实际渲染成 `共 <!-- -->4<!-- --> 个条目`，正则匹配不到 → 会误判成"页面没渲染" | 断言前先 `html.replace(/<!-- -->/g, '')`；验收脚本里统一走这个 normalize |
| **测试里硬写 schema 版本号** | 每加一个迁移，`health.test.ts` 就有 2 条用例变红（"期望 0004、实际 0005"）—— 改一次忘一次，那是噪音不是覆盖 | 改成从 `migrations/` **现取最新文件名**再断言（仍咬住"健康检查报的版本 == 库里实际最新迁移"） |
| **回填脚本不能用 `userId: null` 冒充系统身份** | `acceptPluginSubmission` 对匿名直接抛"收录插件需要先登录"（这是**故意的**安全约束）；我第一次就是这么写的，4 条全被拒 | 借库里一个活跃账号（优先管理员）并**打印用的是谁**（操作会写进 `operation_records`，事后可查）；没有账号则明确拒绝回填 |
| **curl 的 `-w` 与响应体混在 stdout 会互相污染** | 验收脚本把 body 和 `-w '\n%{http_code}'` 一起解析，`Expect: 100-continue` 那一步先打了 `000`，JSON 前缀变成 `\n000\n000{...}` → **登录明明 200 成功却被判失败** | 响应体用 `-o` 落文件、stdout 只留状态码；登录失败时**把原始响应打出来**，别让后来人靠猜 |
| **"重放"必须是同键**且**同摘要** | 我用同一个 requestKey 但每次换正文，得到的是 409 `request_key_reused`（设计如此），**幂等重放路径根本没被走到**，测试却"看起来过了" | 重放用例必须正文逐字一致；并单独断言"同键换正文 → 409" |
| **库的计数表里被拒请求也会被计入** | 我按"计数会被截到上限"写断言，实际 `points` 会涨到 20（上限 5）；差点把正确的实现当成 bug 去修 | 断言要按库的真实语义写：**计数不截断、窗口终点不推后**；退还只在"拿到 ticket 之后"才有意义 |

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

### 5.3 第三轮点击：人工审核 → 回复 → 撤回（13 步，完整表在 README §5.3）

| # | 操作 | 观察到的结果 |
|---|---|---|
| 1 | 浏览器登录（测试通道）→ `/admin` | 提示"不是管理员"，并给出 `grant-admin.mjs` 用法 |
| 2 | `node scripts/grant-admin.mjs --github-login local-dev` | 指定成功；导航栏随即出现「（管理员）」 |
| 3 | 编辑器改标题 → 提交审核 | `pending`；worker（**未开筛查**）→ `manual_review` |
| 4 | `/admin` 点「通过并发布」（**不填原因**） | `input_invalid`：请先填写处理原因 —— 必填拦截生效 |
| 5 | 填原因 → 再点 | 「发布任务 `01a13064-…` 已入队」 |
| 6 | 等 worker | **同一条任务 ID**：`review_publish` → 评测已发布 |
| 7 | 刷新公开页 | 标题换成新修订，`最近更新` 变新；出现「回复」与「作者操作 → 撤回」 |
| 8 | 点「回复」→ 填正文 → 发表回复 | 提交 `01a13065-…` → 检查后 `manual_review`（评论提交也在后台待办里） |
| 9 | `/admin` 通过**这条评论提交** | 「发布任务 `01a13067-…` 已入队」；worker 跑的是 **`comment_publish`** → 评论已发布 |
| 10 | 公开页点「查看 1 条回复」 | 回复以缩进出现在讨论组里（`replyCount=1`） |
| 11 | 「撤回这篇评测」→ 填原因 → 确认 | 「已撤回…历史修订仍然保留」；刷新后页面变「作者已撤回这篇评测。」 |
| 12 | `/onboarding?returnTo=https://evil.example/steal` | 「跳过」链接 href 是 **`/`**（开放重定向被挡） |
| 13 | `/onboarding?returnTo=/me` 改昵称保存 | 跳到 `/me`；`grant-admin --list` 里昵称已改 |

> 第 4→5 与第 8→9 两步最有价值：前者是"通过真的会入队"的正面证据，后者抓出了
> **评论提交必须入队 `comment_publish`**（一律 `review_publish` 的话，评论会静默地永远发不出去）。
> 浏览器点之前，这两条缝都被"验收脚本自己调 `publishReview`"盖着。

### 5.4 真实 GitHub OAuth 往返（2026-10-12 晚，真账号真授权）

App `dsh-plugin-review-dev`、账号 `liceses`、scope `read:user`。完整表在 README §5.4，要点：

| # | 操作 | 结果 |
|---|---|---|
| 1 | 填 Client ID/Secret → 等 dev 自动重载 | 日志 `Reload env: .env.local`；`/api/session` 的 `githubLoginConfigured` 变 `true` |
| 2 | **凭据预检**：拿假 `code` 换 token | `bad_verification_code`（= 凭据配对正确；凭据错会是 `incorrect_client_credentials`）。**这招以后配 OAuth 都该先用** |
| 3 | 点「用 GitHub 登录」 | 真授权页：`dsh-plugin-review-dev` → 账号 `liceses`，仅 *Profile information (read-only)*，回调指向 `127.0.0.1:3100` |
| 4 | 点 `Authorize` | GitHub 随即发授权通知邮件；回调落在 `/onboarding?returnTo=%2F` —— **真实新用户落地页**（上一轮才补的，之前是 404） |
| 5 | 读库 | `users` **只多 1 条**：`01a130c1-31ab-7eeb-b4c5-29db261ca979`，昵称 `icelily`；`external_identities.provider_user_id = 121547321`（稳定数字 ID）、`provider_username = liceses` |
| 6 | 检查引导闸门 | **没有**自动变管理员（库里已有 10 个）—— 设计如此 |
| 7 | `node scripts/grant-admin.mjs --github-login liceses` | 提为管理员；硬刷新后导航栏出现「（管理员）」，`/admin` 可用 |

> 剩下没验的只有**生产域名 / HTTPS / 反代下的回调**（GitHub 每个 App 只允许填一个 callback URL）。

---

## 6. 仓库与提交

- 工作目录：`D:\developing\ds民间科研成果展示\插件测评网站`
- 远程：`origin https://github.com/furongjun-lingshu/dsh-plugin-reviews.git`（**PRIVATE**）
- 提交历史：`5d717ab`（切片）→ `e59a71a`（README dev.cmd 说明）→ `938f32a`（第二轮收口）
  → `c8c4138`（交接书）→ **`ceb7d51`（第三轮：审核闭环 / onboarding / 撤回 / 回复 / 管理员脚本，已推送）**
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
src/server/workflows/  submit-review · publish-review · publish-comment ·
                       decide-submission（人工审核决定 + 入队发布，跨模块协调事务）
src/server/adapters/   login（真实 GitHub OAuth + 测试通道）· catalog（真实 api.github.com 探针）
src/app/               App Router：页面 + /api 路由；页面含 /onboarding、/admin、/me/drafts/[draftId]
src/components/        session-nav · plugin-submit-form · review-editor · comment-section ·
                       start-draft-button · admin-decision-form · profile-form · withdraw-button · api-client
src/worker/            main（独立进程）· handlers（4 处理器）· content-screen（本地基础筛查）
tests/                 22 文件 / 418 测试（用真实临时库 + 真实迁移，**不用 `:memory:`**）
scripts/               验收与自检脚本；grant-admin.mjs（指定/撤销管理员）；check-github-oauth.mjs（凭据体检）
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
| `GET\|POST /api/content/{contentId}/comments` | 评论列表（**仅顶层**）/ 发表（**不是** `/api/comments`；`replyToCommentId` 可选） |
| `GET /api/content/{contentId}/comments/{commentId}/replies` | 组内回复分页（顶层列表里只有 `replyCount`，回复要单独取） |
| `PATCH /api/me/profile` | 保存昵称（`{nickname}`）；新用户落地页用它 |
| `GET /api/reviews/{reviewId}` | 公开详情（未公开 → 404 且不返回正文） |
| `POST /api/reviews/{reviewId}/withdraw` | 作者撤回，需 `expectedControlVersion` + `requestKey` |
| `GET /api/plugins` / `POST /api/plugins` | 列表 / 收录（真实探针）；不存在的仓库 → **400**，不是 503 |
| `GET /api/admin/submissions` | 待办列表 |
| `POST /api/admin/submissions/{submissionId}/decisions` | 人工决定 `{decision:'approve'\|'needs_changes', reason, expectedStateVersion, requestKey}` → `{state, publishTaskId, publishQueued}` |

**版本字段形状**：`{kind:'unknown'}` 或 `{kind:'known', value:'1.2.3'}`。
空值不是"省略"，而是**明确选未知** —— 未知**不是**退回理由（产品规则）。

**页面入口**：写评测只能从 `/plugins/{pluginId}`（插件详情页）发起 —— 评测必须绑定插件。
`/me` 只做引导，不再建无插件的死草稿。

**审核路径**：后台待办里混着**评测提交**与**评论提交**，两类都要人工决定；
"通过"会按 `submission_type` 入队对应的 `*_publish` 任务，真正的发布由 worker 执行。

---

## 9. 测试与验收纪律（**这个项目的核心价值，别丢**）

1. **反同义反复（anti-tautology）**：每个关键测试都要能被"破坏实现"咬红。
   项目里有 `scripts/verify-*-bite.mjs` 系列，做法是：破坏实现 → 断言测试变红 → **按字节还原** → 断言复绿。
   **"第一次就全绿"通常意味着变异脚本本身没生效**。改断言时也一样：本轮把验收脚本的收录断言改成
   动态口径后，专门用**变异副本**（URL 换成真实插件 → 201 成功）验证了它会变红；
   写 `decide-submission` 的测试时也做了同样的事（把入队整段删掉 → 2 条用例变红 → 逐字节还原）。
2. **真实临时文件库 + 真实迁移**，**禁止 `:memory:`** —— 内存库测不出触发器与迁移问题。
3. **禁止恒真断言**（如 `expect(x).toBeDefined()` 当唯一断言）。
4. **单测测不出的东西，靠真进程**：handlers 空注册表、评论发布读在事务外、
   `runRuleCheck` 的 snapshot 不含正文 —— 这三个都是**单测全绿但真跑才暴露**的。
5. **HTTP 验收测不出的东西，靠真的去点**：第 14 条（缺绑定插件入口）、
   第 16 条的子缺陷（评论提交入队错类型）都是这样咬出来的。
6. **验收脚本不能代替真实路径**：第 16 条就是两个脚本在"通过"之后**直接调用 `publishReview`**，
   把"通过之后没人发布"这条缝盖了整整两轮。**脚本替实现干活的地方，就是缺陷能藏身的地方。**
7. **幂等键不能写死**：`acceptance-http.mjs` 曾用固定 `requestKey`，第二次运行就撞
   `request_key_reused(409)` —— 幂等机制正确工作，却让"可重复运行"的验收误报失败。
8. **验收脚本必须可重复运行**，且**不假设库为空**。

---

## 10. 给接手者的最短路径

```cmd
cd /d "D:\developing\ds民间科研成果展示\插件测评网站"
npx tsc --noEmit                 REM 期望 exit 0
npx vitest run                   REM 期望 418 passed / 22 files
dev.cmd                          REM 迁移 + 自检 + 起 Web（3100）
REM 另开窗口：
set DSH_REVIEW_CONTENT_SCREEN=basic
dev.cmd worker                   REM 要真正发布内容就需要它
dev.cmd accept                   REM 读/写/上传/端到端 四段验收（跑之前先停掉常驻 worker）
```

然后：读 §3 挑一件做 —— 要么请主人给 OAuth 密钥把真实登录跑通，
要么把 §3.2 里某条"未做"补上（后台审核页面 / 修订历史界面 / 搜索 是最顺手的三个）。
