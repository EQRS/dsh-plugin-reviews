# DSH Plugin Review · 最小功能切片

> **这条切片做完了什么、没做什么，都在本文件里。**
> 请先读第 2 节「未按文档实现」——它和代码一样是交付物的一部分。

切片范围（主人确认）：**登录 → 收录插件 → 写／审／发一篇评测 → 评论**。

---

## 1. 怎么跑

### 方式一：一键启动脚本（Windows）

```cmd
npm install
dev.cmd
```

`dev.cmd` 会依次：建 `.data` → 应用迁移 → 启动自检 → 拉起 Web（http://127.0.0.1:3100）。

| 命令 | 作用 |
|---|---|
| `dev.cmd` | 迁移 + 自检 + 启动 Web（默认） |
| `dev.cmd web` | 只启动 Web |
| `dev.cmd worker` | 只启动 worker（另开一个窗口） |
| `dev.cmd migrate` | 只跑迁移 + 自检 |
| `dev.cmd test` | 类型检查 + 跑测试 |
| `dev.cmd accept` | 跑 HTTP 验收：读 / 写 / 上传 / 端到端（需 Web 已在运行） |
| `dev.cmd demo` | 造一条演示评测（需 Web 已在运行） |
| `dev.cmd reset` | 删掉 `.data` 重建（仅本地开发） |

> **想走通"提交 → 自动发布"**：默认配置下提交会停在 `manual_review`（安全的保守默认）。
> 本地演示时让 **Web 与 worker 两个进程**都带上：
> ```cmd
> set DSH_REVIEW_CONTENT_SCREEN=basic
> ```
> 再启动。这个变量决定"内容筛查"是否启用；细节与风险见 `.env.example` 与第 2.2 节。

> 脚本用 CRLF + ASCII 输出编写，已在 `core.autocrlf=true` 的环境下**用真实 clone 验证过**检出后仍可执行
> （见 `.gitattributes` 的 `*.cmd text eol=crlf`）。若在 Linux/macOS 上跑，直接用方式二。

### 方式二：直接用 npm 脚本（跨平台）

```bash
npm install
cp .env.example .env.local   # 按需填写 GitHub OAuth / GITHUB_TOKEN
npm run db:migrate      # 建库 + 应用迁移（25 张表 + 18 个触发器）
npm run db:check        # 启动自检：外键、WAL、表齐全、schema 版本
npm run dev             # Web：http://127.0.0.1:3100
npm run worker          # 独立 worker 进程（**要真正发布内容就需要它**）
npm run admin:grant -- --list                    # 看现有用户与管理员
npm run admin:grant -- --github-login <账号>      # 指定管理员（该账号需先登录过一次）
npm test                # 404 个测试
npm run typecheck       # tsc --noEmit
```

### 首个管理员怎么指定（**站内没有提权入口**）

后台 `/admin` 只有管理员能用，而站内**没有任何**"把我变成管理员"的按钮 —— 那是刻意的：
能自我提权才是漏洞。两条路，都在部署侧：

**① 部署配置里引导（推荐：第一次登录就生效）**

```ini
# .env.local
BOOTSTRAP_ADMIN_GITHUB_ID=121547321   # 你的 GitHub 数字 ID，不是用户名
```

取值：`gh api user --jq .id`，或打开 `https://api.github.com/users/<你的用户名>` 看 `id` 字段。
语义是**引导**而不是永久提权：只有当库里**一个可用管理员都没有**时才生效 ——
所以被别的管理员撤销过权限的账号，不会在下次登录时自己变回管理员。

**② 上机指定 / 撤销（已经登录过的账号）**

```cmd
node scripts/grant-admin.mjs --list
node scripts/grant-admin.mjs --github-login <你的 GitHub 账号>
node scripts/grant-admin.mjs --user-id <站内 UUID>
node scripts/grant-admin.mjs --github-login <账号> --revoke
```

- ② 的目标账号必须**先在站内登录过一次**（`users` 行由首次登录建立），否则脚本会明确拒绝并让你先登录。
- `--revoke` 在会把**最后一个可用管理员**降级时拒绝执行（对应 idea.md 第 344 行"系统确保至少保留一个管理员"）。

### 验收脚本（真跑，不是描述）

| 命令 | 做什么 | 当前结果 |
|---|---|---|
| `npx vitest run` | 单元 + 集成 + 端到端（含真实临时库与真实迁移） | **404 passed / 21 files** |
| `npx tsc --noEmit` | 类型检查 | **exit 0** |
| `node scripts/verify-tests-bite.mjs` | **反恒真自检**：删掉盖楼触发器 → 测试必须变红 → 还原 → 必须复绿 | 通过 |
| `node scripts/verify-comment-visibility-bite.mjs` | **反恒真自检**：去掉评论公开修订过滤 → 评论可见性测试必须变红 → 还原（逐字节核对）→ 必须复绿 | 通过 |
| `node scripts/acceptance-http.mjs` | 对**运行中的 dev server** 做 HTTP 验收（需先 `npm run dev`） | **16/16** |
| `npx tsx scripts/acceptance-http-write.mjs` | HTTP 写入链路：登录→建草稿→保存→提交→管理员通过→**入队发布**→发布→公开可读→评论→撤回 | **21/21** |
| `npx tsx scripts/acceptance-upload.mjs` | 图片上传全链路：登记→传字节→就绪→读取→权限→伪装/超限拒绝 | **14/14**（可重复运行） |
| `npx tsx scripts/acceptance-e2e-chain.mjs` | **整条链**：登录→收录真实插件→写→提交→**真 worker 发布**→评论→**回复**→登出 | **22/22** |
| `npx tsx scripts/seed-demo.mjs` | 造一条保持公开的演示评测（用于看页面真实渲染） | 见下 |
| `node scripts/verify-node-cpsync.mjs` | 复核本机 Node 的 `cpSync` CJK 崩溃（环境坑，与本项目功能无关） | 见 `docs/环境坑-cpSync-CJK崩溃.md` |
| `node scripts/check-github-oauth.mjs` | **OAuth 凭据体检**：三个变量齐不齐 + 拿假 `code` 去换 token，区分"凭据错"与"code 错"（**不打印任何密钥**） | 本机：`bad_verification_code` → 凭据正确（退出码 0） |
| `node scripts/diagnose.mjs` | **一屏看全状态**：配置配没配、库结构/大小/外键/WAL、数据量、任务队列与最近失败、worker 心跳、磁盘、媒体目录；`--json` 给监控 | 本机可跑；发现的问题会进"结论"并以退出码 1 报告 |
| `node scripts/worker-healthcheck.mjs` | **worker 容器健康检查**：读它自己写的心跳，过期即退出码 1 | 正反两向真跑过：worker 在跑 → 0；停掉并把阈值压到 1 秒 → 1 |
| `/api/health`（HTTP） | 存活/就绪检查：结构坏了 503；公网 body 不含逐项检查；`?worker=1` 才把 worker 算进结论 | 见 `tests/health.test.ts`（16 条） |
| `npm start`（= `node server.mjs`） | **访问日志**：每请求一行 JSON（`request_id`/方法/路径/状态码/耗时/是否慢），`/api/health` 与 `/_next/*` 静音 | 生产构建下实测：200/404/400 都出行，`request_id` 与响应头/响应体同一个号 |
| 故意抛异常的页面 | **未捕获异常链路**：HTTP 500 + 日志 `request_error`（含 path/digest/stack）+ 错误页显示同一个 digest | 浏览器实测：用户看到「这个页面出错了」与编号 `2387506696`，日志里是同一个值 |
| `node scripts/acceptance-catalog-browse.mjs` | **插件目录浏览验收**：搜索 / 通配符转义 / 标签筛选 / 是否有评测 / 排序 / 越界页 / 首页入口 / 未知 id → 404（对**运行中**的服务发真请求，不假设库里有几条数据） | **10/10** |
| `npx tsx scripts/backfill-plugin-info.mjs` | **存量条目回填展示资料**（迁移 0005 之后的补数据）：对缺 `info_updated_at` 的条目重跑收录检查，幂等、失败只跳过；默认 dry-run，`--apply` 才写 | dry-run 列出 4 条；`--apply` → **成功 1 条**（真实仓库的简介/topics/头像/版本真写进库）、跳过 3 条（本地测试造的假仓库，报"仓库不存在"） |

> `acceptance-http*.mjs` 需要 dev server 在跑；它们走真实 HTTP，不是调用函数。
> 它们都**不假设库里没有别的数据**（早先版本假设为空，被演示数据干扰过，已修），
> 且**都可重复运行**（`acceptance-upload.mjs` 早先用写死的 UUID 造评测，第二次运行会撞
> `UNIQUE constraint failed: content_entities.id` —— 那是脚本自身的隔离缺陷，已改为每次新建 ID）。
>
> 上面五个数字是 **2026-10-12 重跑**的结果（同一台机器、真 GitHub、真 worker）。
> 其中 `acceptance-http.mjs` 当时**先读出 15/16** —— 不是实现坏了，是脚本自己的收录断言过时了
> （探针接真实 api.github.com 之后，不存在的仓库应当返回 400 而不是桩时代的 503）。
> 详见 §5 第 15 条。

### 让"真实登录"生效，需要主人做两件事

这两件事我用代码做不了（需要主人的账号与密钥），**没做之前相关功能会明确报"未配置"，不会假装可用**：

**① 建 GitHub OAuth App（真实登录）**

1. 打开 https://github.com/settings/developers → **New OAuth App**
2. 填写：
   - Application name：随意，如 `dsh-plugin-reviews-local`
   - Homepage URL：`http://127.0.0.1:3100`
   - Authorization callback URL：`http://127.0.0.1:3100/api/auth/github/callback`
3. 建好后把 **Client ID** 与 **Client secret** 填进 `.env.local`：

```ini
GITHUB_CLIENT_ID=你的ClientID
GITHUB_CLIENT_SECRET=你的ClientSecret
GITHUB_REDIRECT_URI=http://127.0.0.1:3100/api/auth/github/callback
SESSION_SECRET=至少32字节的随机字符串
```

4. 重启 `npm run dev`，导航栏的"用 GitHub 登录"就会真的跳到 GitHub 并回调。

> `GITHUB_REDIRECT_URI` 必须与 OAuth App 里填的**完全一致**（含协议、端口、路径）。
> 用 `127.0.0.1` 而不是 `localhost`，避免解析差异导致回调不匹配。
> `SESSION_SECRET` 生产环境**必须**设置：否则服务端拒绝发起登录，避免明文保存 PKCE verifier。

**② 配 `GITHUB_TOKEN`（收录插件，可选但强烈建议）**

未认证的 api.github.com 只有 **60 次/小时**，实际会撞限流（实测撞过）。
配一个 token（不需要任何 scope，公开仓库只读即可）可提到 5000 次/小时：

```ini
GITHUB_TOKEN=ghp_xxx   # 或 gh auth token 的输出
```

> 真机验证（2026-10-11）：配上 token 后，收录 `deepseek-ai/deepseek-harness` 的
> `packages/bundle/base` 成功；不配时如实返回 `provider_unavailable` 并带上 GitHub 的限流说明。

**本地测试登录通道**（不想建 OAuth App 时用）：

```ini
DSH_REVIEW_ALLOW_TEST_LOGIN=1
```
导航栏会出现"测试登录"按钮。它**只在非生产环境且显式设为 1 时可用**，生产环境即使设了也不生效。

---

## 2. 未按文档实现（**逐条如实列出**）

设计文档（`idea.md` / `架构设计.md` / `数据库模型.md`）描述的是完整 P0。本切片**刻意收窄**，以下是**没做**的部分。

### 2.1 明确未实现的功能范围

| 未实现 | 文档依据 | 影响 |
|---|---|---|
| 整合包（创建／版本／清单／安装命令） | 需求 §26、§27；架构 §35、§36 | `/packs` 相关全部不存在。`content_entities` 用 `CHECK (content_type='review')` 明确拦住，不会出现"看着存在其实没内容"的孤儿行 |
| 收藏、有帮助、举报、复核、纠错 | 需求 §13、§15、§20 | 表与接口均未建 |
| 站内通知 | 需求 §11；架构 §41 | 表与消费逻辑均未建 |
| 关键词搜索（FTS5 / trigram） | 架构 §9、§63 | 列表只做分页，**没有搜索框** |
| 图片与附件的**格式转换、多尺寸集、存储源迁移** | 需求 §6；架构 §10、§45—47 | 上传/校验/压缩/展示变体已做；多 CDN、迁移未做 |
| 批量导入、集中投稿、公平队列 | 需求 §25；架构 §72、§73 | 无 `/me/batches` |
| 备份与恢复 | 架构 §28、§54 | 无备份入口 |
| 真实外部 AI 内容筛查 | 需求 §9；架构 §20 | 内置的只是**本地确定性基础筛查**（词表 + 长度下限 + 刷屏检测），**不是真实审核服务**。默认关闭，关闭时提交停在 `manual_review`（正确行为） |
| 真实 GitHub OAuth 往返 | 架构 §11；部署 §5 | **代码已完整实现**（PKCE + state + 浏览器绑定），但需要主人自建 OAuth App 填 Client ID/Secret 才生效；未配置时明确报未配置。见 2.2 |
| GitHub **目录发现 / 定时同步** | 需求 §1；架构 §92—99 | 收录检查已接真实 api.github.com；**发现与同步未做**（只有"粘链接自助收录"） |
| 管理员后台的完整栏目 | 需求 §23；架构 §90、§91 | 有"待办列表 + 通过/需修改（带必填原因）"；**仍缺**：站内授予/撤销管理员、举报与纠错处理、操作记录查看。指定管理员用 `scripts/grant-admin.mjs` |
| 修订历史查看、旧版对比 | 需求 §10 | 快照保留在库里，但**没有读取界面** |
| Docker / Compose / Linux 构建 | 部署 §1—3 | 只验证了本机 Windows + Node 24 |

### 2.2 外部依赖的真实状态（**不伪装可用**）

| 外部能力 | 当前行为 |
|---|---|
| GitHub OAuth | **已配置并在本机跑通一次真实往返**（2026-10-12 晚，App `dsh-plugin-review-dev`）：授权页 → 回调 → 建号 → `/onboarding` → 指定管理员，全程浏览器点击，见 §5.4。实现上仍是 S256 PKCE + state 摘要 + 浏览器绑定 Cookie + 一次性消费；scope 只要 `read:user`。**未验证**：生产域名 / HTTPS / 反代下的回调（GitHub 每个 App 只允许填**一个** callback URL） |
| GitHub 收录检查 | **已接真实 api.github.com**（真机验证：收录 `deepseek-ai/deepseek-harness` 的 `packages/bundle/base` 成功；仓库根无 `dsh.bundle` → 400；不存在的仓库 → 400 且不泄露存在性）。匿名 60 次/小时，建议配 `GITHUB_TOKEN` |
| 内容筛查 | 默认（未设 `DSH_REVIEW_CONTENT_SCREEN`）→ 提交转 `manual_review`，**绝不自动放行、也不认定违规**。设 `=basic` 启用本地基础筛查，通过则自动发布 —— 仅用于本地/演示，**不是真实审核** |

### 2.3 已知的实现偏离（有意的）

| # | 偏离 | 原因与影响 |
|---|---|---|
| 1 | **迁移用新手写 SQL + `schema_migrations` 表**，不是 Drizzle-Kit 生成流水线 | 本切片需要延迟外键、联合唯一、部分唯一索引、行内 CHECK 与跨行触发器，Drizzle 生成器表达不稳。**权威结构是 `migrations/*.sql`** |
| 2 | `drizzle-orm` **只作为依赖存在，未在业务代码中使用** | 业务查询直接走 better-sqlite3 参数化语句。契约第 97 行要求"不暴露 Drizzle 查询对象"这一点是满足的 |
| 3 | 业务参数写成**模块内常量**，未接配置服务 | `site_settings` / `configuration_revisions` 表已建但仅留位。文档（需求 §24、架构 §12/§50）要求后台可调 + 版本快照 + 审计 |
| 4 | **评论入队在业务事务之后**（架构 §78.1 要求"同一事务"） | `withTransaction` 回调必须同步，而 tasks 加载是异步的。评论已建但入队失败会**显式抛错**让调用方重试，不静默吞 |
| 5 | `hide` / `unhide` / `withdraw` **未写 `operation_records` 去重** | 幂等目前只覆盖：草稿保存、提交、插件收录三处 |
| 6 | ~~worker 的 handlers 注册表为空~~ **已修**：注册了 `review_check` / `review_publish` / `comment_check` / `comment_publish` 四个处理器 | 曾导致提交后永远停在 `pending`、评论创建后不公开。现：检查通过 → 转 `approved` → **再入队一个 `*_publish` 任务**（职责分离、可重试），由 `workflows/publish-review.ts` / `publish-comment.ts` 发布。未注册类型仍记 `skipped` + `no_handler`，**不假装成功** |
| 7 | 会话 Cookie 在**开发环境不带 `__Host-` 前缀** | `__Host-` 强制要求 `Secure`，http 下浏览器/curl 会直接丢弃 → 表现为"登录 200 但立刻匿名"。生产环境仍用 `__Host-dsh_session`，见 `platform/session-cookie.ts` |
| 8 | `parseSubmissionUrl` 对 `branch` 含 `/` 有**固有歧义** | 按"第一段为分支、其余为路径"处理，注释已写明；建议用 40 位 commit SHA 永久链接 |
| 9 | **公开列表/详情页没有关键词搜索与筛选** | 需求 §16—18 要求搜索、分类筛选、排序；本切片只做分页 + 公开资格过滤 |
| 10 | ~~页面没有登录入口与编辑器表单~~ **已修**：`session-nav`（GitHub/测试登录 + 登出）、`plugin-submit-form`、`review-editor`（Markdown + 图片插入 + 保存/提交）、`comment-section` | 仍缺：修订历史界面、搜索。**写评测的入口在插件详情页**（评测必须绑定插件），`/me` 只做引导；后台审核按钮、作者撤回、评论回复、`/onboarding` 已在第三轮补上（见 §5 第 16、17 条） |
| 11 | 评测**必须**绑定插件才能提交（`validateForPublish` 校验 `plugin_id`；`review_revisions.plugin_id` 是 NOT NULL 外键） | 这是产品规则，不是缺陷。所以"写评测"只能在插件页发起：凭空建的、`plugin_id` 为空的草稿**保存得了、提交不了**，是一条死路（真踩过，见 §5 第 14 条） |
| 12 | `acceptance-http.mjs` 的收录断言曾写死 `503` | 探针还是桩时的口径；接上真实 api.github.com 后，不存在的仓库会（正确地）返回 400 → 脚本误报失败。已改为断言"明确拒绝且不假装成功"（400/503 + 错误码白名单），并用变异副本验证过它会咬（见 §5 第 15 条） |
| 13 | **评论发布没有 `superseded` 资格检查**（评测有） | `publishReview` 用 `latest_submitted_revision_id` 挡"被新提交取代的旧快照"。评论侧**不能照抄**：评论提交路径从未写这一列，恒为 NULL，照抄会让所有评论都判 superseded、一条也发不出去（**曾经真写错过一次，被实跑测试立刻抓出**）。评论当前只有"首次提交即修订"一条路径，故该状态尚不可能出现；**将来支持编辑评论时必须同时**维护该列并加回检查 |
| 14 | `.env.example` 里的 `SITE_ORIGIN` **当前没有任何代码读取** | 预留给将来的绝对链接 / 邮件 / 分享卡片。真正决定登录回调的是 `GITHUB_REDIRECT_URI`。已在 `.env.example` 里如实标注"当前未读取"，免得部署者以为改了它就能换域名（同类的 `BOOTSTRAP_ADMIN_GITHUB_ID` 已实现，见 §5 第 18 条） |

### 2.4 测试覆盖的真实边界（**不要高估**）

- `runRuleCheck` 的「标题非空」「插件未绑定」两条分支**无法做集成测试**：库里 `review_revisions.title` 有 `CHECK(trim(title)<>'')`、`plugin_id` 是 NOT NULL 外键，这两种缺项**落不了库**。这两条只由纯函数 `evaluateRules` 覆盖。
  **没有**为了让测试覆盖而放宽表约束——约束是防线，价值高于覆盖率数字。
- 跨**进程**并发抢任务未实测：单测在同连接上用 `Promise.all`，依赖 `UPDATE` 的原子 WHERE 条件。
- `MAX_CONCURRENT_TASKS=4` 的"同时运行"语义只断言了"一轮最多领 4 条"，未做真实并发压测。
- **"点按钮"这一层仍然没有自动化脚本**（没引入 Playwright）。现有的是「人工用浏览器工具点一遍」
  （§5.2，有 id 与时间戳）＋ HTTP 链路验收。人工点击**可复现、但不会自动重跑** —— 回归时它会漏。
- 图片「插入图片」按钮**没有被浏览器驱动验证过**：它弹出的系统文件选择器工具操作不了。
  图片链路只验到 HTTP 契约层（`acceptance-upload.mjs` 14/14，含真字节、权限、伪装与超限拒绝）。
- **真 GitHub OAuth 往返未实测**：代码完整，但需要主人自建 OAuth App 才能验证。
  我没有 OAuth App 的 Client Secret，**不能声称它已跑通**。
- 收录探针的**多 patch 数组**只核验第一条（见 `docs/最小切片-设计映射.md` §3.1）。
- 跨**进程**并发抢任务未实测（单进程 + 真 worker 已实测）。

---

## 3. 版本固定与偏离记录

文档候选版本**一个都没降**（实测 registry 上均存在，且本机可用）：

| 包 | 文档候选 | 实际安装 |
|---|---|---|
| next | 16.4.0 | **16.4.0** |
| react / react-dom | 19.3.0 | **19.3.0** |
| typescript | 7.0.2 | **7.0.2** |
| drizzle-orm | 0.45.4 | **0.45.4** |
| better-sqlite3 | 13.0.3 | **13.0.3**（Node v24.12.0 上原生绑定可用，内嵌 SQLite 3.53.4） |
| zod | 4.6.5 | **4.6.5** |
| vitest | 5.0.3 | **5.0.3** |
| tsx | 4.23.15 | **4.23.15** |

**唯一的环境偏离**：文档写目标 Node **24.21.0**，本机是 **24.12.0**。未在 24.21.0 上验证。

---

## 4. 反恒真自检（为什么这些测试可信）

测试全绿本身没有意义——**恒真断言也会绿**。本项目做了两层防护：

### 4.1 脚本化自检
`scripts/verify-tests-bite.mjs`：删掉 `trg_comments_reply_group_insert` → 跑约束测试 → **必须失败** → 还原 → **必须通过**。
实测输出：`✅ 步骤 1：删掉盖楼触发器 → 测试如期变红` / `✅ 步骤 2：恢复 → 重新通过` / `结论：约束测试不是恒真断言。`

### 4.2 各模块的变异矩阵（由各实现者自报，主控抽查）

| 桶 | 破坏点 | 期望变红 |
|---|---|---|
| GI | 去掉幂等查询 / 短路 dsh.bundle 检查 / token 改存明文 / 重复回调 always insert / 去掉 revoked_at 检查 | catalog 2+1、identity 8+3+2 |
| GF | 堆栈塞进响应体 / 原样回传 message / 未登记 code 不兜底 / request_id 放行换行 | 4/4 变红 |
| GC | 删 `save_version` WHERE 条件 / 删重放分支 / 删摘要比较 / 去掉 withdrawn/hidden 判断 / 撤回不递增版本 / root 解析退化 / 去掉跨对象校验 / 去掉顶层过滤 | 10/10 变红 |
| GT | 去掉 renew token 校验 / 去掉租约过期校验 / finish 去掉双层 CAS / claim 改非原子 / 不记 lease_expired / 重试预算永不耗尽 / 筛查未配置直接放行 / 把未知当缺项 / transition 不校验版本 / operations 不比对摘要 | 10/10 变红 |

---

## 5. 施工中真实抓到并修掉的缺陷

这些都是**测试或变异逼出来的**，不是推测：

| # | 缺陷 | 怎么发现的 | 修法 |
|---|---|---|---|
| 1 | `content_entities` 缺 `created_at`，索引建不上 | `npm run db:migrate` 报 `no such column` | 补列（对照 `数据库模型.md` 第 73 行确认文档确有该字段） |
| 2 | 公共实体与子类型**没有真正延迟** | 约束测试"孤立父记录被拒绝"失败 | 改成显式 `DEFERRABLE INITIALLY DEFERRED`；实测证明只有显式标注才生效 |
| 3 | `pack_release` 可写入无子表承接的孤儿行 | 约束测试失败 | 加切片闸门 `CHECK (content_type='review')` |
| 4 | 我给的规格里导入路径写成 `@server/...` | GI 跑 tsc 报 TS2307 | 通知 GC 改成 `@/server/...`；**未越权改队友文件** |
| 5 | `assertCanWrite` 抛裸 `Error` → 未登录/禁用被折成 **500** | `gf-platform` 验收时发现 | 改抛 `DomainError`；加回归测试 `auth-errors.test.ts` |
| 6 | `withdraw(reason:null)` 撞成对 CHECK → 冒裸 SqliteError | GC 自测发现 | 落占位文案 + 补两条用例 |
| 7 | 重试预算每次等待后被清零 → 任务**永不进入 failed** | GT 测试逼出 | 改为按累计 `attempt_count` 判定 |
| 8 | `transitionWithin` 漏传 `now` → NOT NULL 失败 | GT 测试逼出 | 给默认值 `nowMs()` |
| 9 | `finish` 的 skipped 分支丢弃 errorCode | GT 测试逼出 | 记录错误码 |
| 10 | **会话在 http 下立刻丢失**（登录 200 但下一次请求就匿名） | **HTTP 验收脚本**（只有真跑才会暴露） | 开发环境改用不带 `__Host-` 前缀的 Cookie 名 |
| 11 | `POST /api/drafts` 同时承担"新建"和"保存" → 保存请求被当新建、**静默返回未保存的草稿** | HTTP 写入验收 | 方法语义拆开：POST 新建 / PUT 保存 / PATCH 提交 |
| 12 | 人工决定路由**没有动态段**却解构 `submissionId` → 500 | HTTP 验收 + 读 dev server 日志拿到真实堆栈 | 拆到 `.../{submissionId}/decisions` |
| 13 | **未公开的评论会出现在公开列表**（`listRootComments` / `listReplies` / `countReplies` 都缺 `published_revision_id IS NOT NULL` 过滤） | 页面证据检查发现"评论已提交但详情页看不到" → 读库确认 `published_revision_id` 为 null → 但 API 却把它返回了 | 三处都补上公开修订过滤；新增 `tests/comments-visibility.test.ts`（3 用例）+ `scripts/verify-comment-visibility-bite.mjs` 反恒真自检 |
| 14 | **评测根本没有"选择插件"的入口**：插件详情页（设计文档指定的入口）没挂按钮，`/me` 的「写一篇评测」却建出 `plugin_id` 为空的草稿 —— 它能保存、能显示，**点提交才报"请选择插件"**，而界面上没有任何办法补救 | **人工浏览器点击链路**（HTTP 验收与 357 个单测全绿，全都没碰到这一层：它们都从 API 直接带 `pluginId` 建草稿） | 插件详情页挂 `StartDraftButton pluginId={plugin.pluginId}`；`/me` 改成引导到插件目录；编辑器顶部显式显示"关联插件"或"未关联 → 无法提交"的告警。见 §5.2 |
| 15 | `acceptance-http.mjs` 的收录断言**过时**：写死要求 `503` | 跑全量验收时读出 15/16。查因：探针接真实 api.github.com 之后，不存在的仓库**本就该**返回 400（`input_invalid` + 具体原因），503 只是当年探针还是桩时的口径 | 改成"明确拒绝且不假装成功"（400/503 + 错误码白名单 + `ok=false`）；再用**变异副本**把 URL 换成真实插件目录（201 成功）验证它会变红 —— 断言不是恒真的 |
| 16 | **管理员点"通过"之后没有任何东西会去发布**：`decideByAdmin` 把状态推到 `approved` 就结束了。页面上的"审"要么没有按钮（当时），要么按了也不会公开 | 第三轮做后台审核按钮时，**读代码**发现 `moderation.decideByAdmin` 里没有任何入队动作。两个验收脚本都在"通过"之后**直接调用 `publishReview`**，正好把这条缝盖住 | 新增 `workflows/decide-submission`：决定 + **按提交类型**入队发布任务（评测 → `review_publish`，评论 → `comment_publish`）。新增 `tests/decide-submission.test.ts`（5 用例，含"评论提交必须入队 comment_publish"）；变异测试证实：把入队整段删掉 → 2 条用例变红 |
| 17 | **一批"接口都有、页面没有"的半截功能**：① callback 对新用户 302 到 `/onboarding`，而**这个页面根本不存在**（真实 OAuth 新用户一登录就 404）；② `identity.updateProfile` 实现了却**没有路由**，资料确认页无从保存；③ `commentsService.listReplies` 实现了却**没有路由**，评论只能看到"3 条回复"这个数字、点不开也回不了；④ 作者撤回只有 API，页面上没有按钮 | 逐页清点"用户能点的地方"（不是读代码猜，是列清单逐条对） | 补 `/onboarding`（含 `returnTo` 开放重定向防护，只接受站内路径）+ `PATCH /api/me/profile` + `/api/content/{id}/comments/{cid}/replies`（补内容可见性与归属核对）+ 作者撤回按钮（两段确认）+ 评论回复 UI（懒加载展开）。见 §5.3 |
| 18 | `.env.example` 里写的 `BOOTSTRAP_ADMIN_GITHUB_ID`（首个管理员的**部署配置**路径）**没有任何代码读取** —— 部署者照着填，然后什么也不会发生 | 准备给主人写"OAuth 怎么配"的步骤时顺手核了一遍 `.env.example` 的每一行，发现它和 `SITE_ORIGIN` 都是死变量 | 接上：`signInWithGithub` 在读/建用户后调用 `bootstrapAdminWithin`。语义**收紧成引导**——只有 `provider_user_id` 完全匹配、且**当前一个可用管理员都没有**时才提升（否则被降权的账号下次登录会自己变回来，"撤销"永远无效）。新增 `tests/bootstrap-admin.test.ts`（5 用例）；变异验证：删掉那道闸 → 第 3 条变红。`SITE_ORIGIN` 没实现，如实标注为"当前未读取" |

> 第 13 条值得单独说明：它同时暴露了两件事——
> ① 公开读取漏了可见性过滤（**真实漏洞**，会泄露尚未通过检查的内容）；
> ② 评论创建后**没有任何东西把它发布**（当时只做了 `comment_check` 入队，
> 没有评论发布处理器，因为 worker 的 handlers 注册表是空的）。
> 修好过滤后，行为从"错误地可见"变成"正确地不可见"，两者不能混为一谈。
>
> **这两条现在都已修**：worker 注册了 4 个处理器（§2.3 第 6 条），评论会真的走到 `published`；
> 过滤也保留着。端到端验收（`scripts/acceptance-e2e-chain.mjs`）里有一条专门断言
> "评论经 worker 发布并公开且出现在公开列表" —— 它同时守住"能发布"和"过滤没写坏"。

---

## 5.1 端到端链路验收（新增）

`scripts/acceptance-e2e-chain.mjs` 与三个单段验收脚本的分工：单段脚本验证读/写/上传各自能通；
本脚本验证**整条链真的走到底**，且由**独立 worker 进程**处理任务（不是测试桩）。

实测（2026-10-11，真 GitHub + 真 worker + 真 SQLite）：

```
登录 → 会话接口如实报告 GitHub 是否已配置 → 收录真实插件（api.github.com）
→ 建草稿 → 保存（saveVersion 递增）→ 过期版本保存被拒（version_conflict）
→ 提交（pending，不假装已发布）→ 真 worker 处理 → published
→ 公开修订指针切换 → 匿名可读 → 发评论 → worker 发布 → 出现在公开列表
→ 发回复 → worker 发布 → 从「组内回复」路由读到 → 计入 replyCount → 拿回复 ID 当讨论组取回复被拒
→ 登出 → 登出后写操作 401
==== 端到端链路验收：22/22 通过 ====
```

**为什么这个脚本值得存在**：handlers 注册表为空时，所有单测与单段验收**都是绿的** ——
只有真进程能暴露"提交后永远没人处理"。同类问题（评论发布读在事务外）也是靠真跑才发现的。

---

## 5.2 浏览器点击链路（人工，工具驱动）—— 2026-10-12

**为什么必须点**：这一层是 HTTP 验收与 404 个单测**都覆盖不到**的 —— 它们一律直接从 API 带好
`pluginId` 建草稿，于是"页面根本没有绑插件的入口"这件事，谁也咬不出来（§5 第 14 条）。

一次完整的点击记录（浏览器工具；dev server `http://127.0.0.1:3100`；worker 以 `DSH_REVIEW_CONTENT_SCREEN=basic` 启动）：

| # | 操作 | 观察到的结果 |
|---|---|---|
| 1 | 插件目录 → `deepseek-ai/deepseek-harness / packages/bundle/base` | 详情页出现「写一篇评测」 |
| 2 | 点「写一篇评测」 | 新草稿 `01a12f6a-fe61-7fa9-a29b-8fe7c8f027de`，保存版本 0，顶部显示「关联插件：`01a12ac1-0250-7446-987f-05df4cbca276`」 |
| 3 | 填标题与正文 → 点「保存」 | 保存版本 0 → 1，页面提示「已保存，保存版本 1。」 |
| 4 | 点「提交审核」 | 先自动保存（1 → 2）再提交：`01a12f6b-2e08-7c7f-869e-68ff779ec299`，状态 `pending`（未假装已发布） |
| 5 | 不干预，等 worker | worker 日志：`review_check` → `approved` → 入队 `review_publish` → **评测已发布** |
| 6 | 打开 `/me` | 提交记录中该条显示**已发布**（17:21:55） |
| 7 | 打开公开页 `/reviews/01a12f6a-fe60-7e51-8048-daa5985c610f` | 正文渲染（Markdown 加粗/列表）、结构化版本栏、评论框可用 |
| 8 | 输入评论 → 点「发表评论」 | 提示"评论已提交，正在等待检查"；worker 随后 `comment_check` → `comment_publish` → **评论已发布** |
| 9 | 刷新公开页 | 「评论（1）」出现该评论，时间戳 17:22:39 |

**没点到的**：图片「插入图片」—— 弹的是系统文件选择器，浏览器工具驱动不了（见 §2.4）。

---

## 5.3 浏览器点击链路（第三轮：人工审核 → 回复 → 撤回）

这一轮的目标是"**把页面上的洞补上并真的点通**"（§5 第 16、17 条）。
环境：dev server `http://127.0.0.1:3100`；worker **不带** `DSH_REVIEW_CONTENT_SCREEN`
（`screen_enabled:false`）启动 —— 这样提交才会真的落到 `manual_review`，走人工那条路。

| # | 操作 | 观察到的结果 |
|---|---|---|
| 1 | 用浏览器登录（测试登录）→ `/admin` | 显示"登录账户不是管理员"，并给出 `scripts/grant-admin.mjs` 的用法 |
| 2 | 终端执行 `node scripts/grant-admin.mjs --github-login local-dev` | 「已指定管理员：local-dev（`01a12ac4-…`）」，随后列出全部用户与管理员数 |
| 3 | 编辑器里改标题 → 点「提交审核」 | 提交 `01a13063-30a4-…`，状态 `pending`；worker 日志随即 `manual_review`（**未配置筛查绝不放行**） |
| 4 | `/admin` 点「通过并发布」（**先不填原因**） | 「操作失败（`input_invalid`）：请先填写处理原因。」—— 必填拦截生效 |
| 5 | 填原因 → 再点「通过并发布」 | 「已通过，发布任务 `01a13064-0dd1-…` 已入队（由 worker 执行发布）」 |
| 6 | 不干预，看 worker 日志 | 同一条任务 ID：`task_type: review_publish` → **评测已发布**（`01a12f6a-fe60-…` 指针切换） |
| 7 | 公开页 | 标题换成新修订，`最近更新 21:53:46`；评论旁出现「回复」，侧栏出现「作者操作 → 撤回这篇评测」 |
| 8 | 点「回复」→ 填正文 → 「发表回复」 | 横幅"正在回复 `01a12ac4-…`"，按钮变「发表回复」；提交 `01a13065-0b6f-…` → 检查后落在 `manual_review` |
| 9 | `/admin` 找到这条**评论提交**并通过 | 「发布任务 `01a13067-168c-…` 已入队」；worker 日志 `task_type: **comment_publish**` → **评论已发布** |
| 10 | 刷新公开页 → 点「查看 1 条回复」 | 回复以缩进形式出现在讨论组里（`回复数 1`，时间戳 21:57:06） |
| 11 | 侧栏「撤回这篇评测」→ 填原因 → 「确认撤回」 | 「已撤回。这篇评测不再对读者公开，历史修订仍然保留」；刷新后页面变「作者已撤回这篇评测。」 |
| 12 | `/onboarding?returnTo=https://evil.example/steal` | 「跳过，直接进入」的链接 href 是 **`/`**（开放重定向被挡）；填 `returnTo=/me` 后保存昵称 | 
| 13 | `/onboarding?returnTo=/me` 改昵称并保存 | 跳到 `/me`；`grant-admin --list` 里该用户昵称已变成 **零式验收猫** |

> 第 4→5 步和第 8→9 步是本轮最有价值的两次点击：
> 前者证明"通过"真的会**入队**（第 16 条断点的正面证据），
> 后者证明发布任务类型**按提交类型选**（第 16 条里那个"评论永远发不出去"的子缺陷）。
> 这两条现在也都有自动化：`tests/decide-submission.test.ts`（5 用例）+ 端到端脚本的 4 条回复断言。

**没点到的**：图片「插入图片」—— 弹的是系统文件选择器，浏览器工具驱动不了（见 §2.4）。

---

## 5.4 真实 GitHub OAuth 往返（2026-10-12 晚，**真账号、真授权**）

在此之前，OAuth 只验到"未配置时明确 503 且不伪装可用"。这一节是**第一次真往返**：
App `dsh-plugin-review-dev`、账号 `liceses`、scope `read:user`。

| # | 操作 | 观察到的结果 |
|---|---|---|
| 1 | 填 `.env.local` 的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`，等 dev server 自动重载 | 日志出现 `Reload env: .env.local` |
| 2 | `GET /api/session` | `githubLoginConfigured: true`（此前 `false`） |
| 3 | 凭据**预检**：拿一个假 `code` 去换 token | `error: bad_verification_code` —— 说明 client_id/secret **配对正确**，只是 code 是假的（凭据错会返回 `incorrect_client_credentials`） |
| 4 | `GET /api/auth/github/start?returnTo=%2Fplugins` | 302 到 `github.com/login/oauth/authorize?...&scope=read%3Auser&state=…&code_challenge=…&code_challenge_method=S256` |
| 5 | 登出旧会话 → 导航栏出现「用 GitHub 登录」→ 点它 | GitHub 授权页：`dsh-plugin-review-dev` wants to access your **liceses** account，仅 *Profile information (read-only)*，`Authorizing will redirect to http://127.0.0.1:3100` |
| 6 | 点 `Authorize liceses` | GitHub 随即发来"a third-party OAuth application has been added to your account"通知邮件；浏览器回到站点 |
| 7 | 回调落在 `/onboarding?returnTo=%2F` | **真实新用户首次登录的落地页**（这一页上一轮才补上，之前 302 过来就是 404） |
| 8 | 读库核对 | `users` 只有 **1** 条新行：`01a130c1-31ab-7eeb-b4c5-29db261ca979`，昵称 `icelily`（取自 GitHub 资料），role `user`；`external_identities` 的 `provider_user_id = 121547321`（**稳定数字 ID**，不是用户名）、`provider_username = liceses` |
| 9 | 保存昵称 | 跳回 `/`，导航栏显示该用户 ID |
| 10 | 此时**没有**自动变成管理员 | 正确：引导闸门要求"当前一个可用管理员都没有"，而库里已有 10 个（验收留下的测试账号） |
| 11 | `node scripts/grant-admin.mjs --github-login liceses` | 「已指定管理员：icelily（`01a130c1-…`）」；硬刷新后导航栏出现「（管理员）」 |
| 12 | 打开 `/admin` | 待办列表与「通过并发布 / 需修改」表单正常，页脚同时提到 `review_publish` 与 `comment_publish` |

> 这一遍确认了三件事：授权 URL 的参数齐全（scope 最小、有 state 与 S256 challenge）、
> 回调确实建号并**只建一条**（稳定 ID 幂等）、以及落地页与管理员引导在真实路径上都能用。
> 仍然**没验证**的：生产域名 / HTTPS / 反向代理下的回调 —— GitHub 每个 App 只允许填一个 callback URL。

---

## 6. 代码地图

```
migrations/            0001_baseline.sql / 0002_triggers.sql / 0003_auth_media.sql
                       —— 25 表 / 18 触发器，权威结构
src/packages/common/   错误码、结果与分页、字段规则、状态文案（浏览器可用）
src/server/platform/   db / tx / time / id / digest / log / context / migrate /
                       errors-http / request-id / session-cookie / file-store / markdown
src/server/modules/    identity · catalog · reviews · content · comments ·
                       moderation · tasks · operations · media
src/server/workflows/  submit-review · publish-review · publish-comment ·
                       decide-submission（人工审核决定 + 入队发布，跨模块协调事务）
src/server/adapters/   login（真实 GitHub OAuth + 测试通道）· catalog（真实 api.github.com 探针）
src/app/               App Router：页面 + /api 路由；页面含 /onboarding（新用户落地页）、
                       /admin（待办 + 人工决定）、/me/drafts/[draftId]（编辑器）
src/components/        session-nav · plugin-submit-form · review-editor · comment-section ·
                       start-draft-button · admin-decision-form · profile-form · withdraw-button · api-client
src/worker/            main（独立任务进程）· handlers（4 个处理器）· content-screen（本地基础筛查）
tests/                 21 个文件 / 404 个测试（含 support/db.ts 真实临时库）
scripts/               验收与自检脚本；grant-admin.mjs（指定/撤销管理员）
docs/                  设计映射、并行分组协议、模块签名契约、验收纪律、环境坑
```

配套文档：
- [最小切片-设计映射.md](docs/最小切片-设计映射.md) —— 每条实现 ↔ 文档章节
- [验收纪律.md](docs/验收纪律.md) —— 怎么判断"真的做完了"
- [模块签名契约.md](docs/模块签名契约.md) —— 并行接口与主控裁决记录
- [环境坑-cpSync-CJK崩溃.md](docs/环境坑-cpSync-CJK崩溃.md) —— 本机 Node 的一个真实坑

---

## 7. 结论口径

**可以说的**：

- 这条垂直链路在本机真实跑通了：**404 单测** + HTTP 验收（读 **16/16**、写 **21/21**、上传 **14/14**）
  + **端到端整条链 22/22**（含**真 worker 进程**把内容从 `pending` 推到 `published`）。
- **页面上真的能点通**（两轮）：插件页 → 写评测 → 保存 → 提交 → worker 发布 → 公开可读 → 评论（§5.2）；
  后台 → 人工通过 → **入队发布 → worker 发布**、评论回复、作者撤回、`/onboarding` 改昵称（§5.3）。
  **这两轮各咬出过一批 HTTP 验收咬不到的缺陷**（§5 第 14、16、17 条）。
- **收录插件已接真实 api.github.com 并真机验证**：真实组合包目录收录成功、仓库根无 `dsh.bundle`
  被正确拒绝、不存在的仓库返回干净 400 且不泄露存在性。
- **GitHub OAuth 已跑通一次真实往返**（2026-10-12 晚，真账号真授权）：授权页 → 回调 → 建号（**只建一条**，认稳定数字 ID）→ `/onboarding` → 指定管理员，全在浏览器里点过（§5.4）。生产域名 / HTTPS 下的回调仍未验证。
- 核心不变量有真实数据库约束与**反恒真自检**兜底（破坏实现 → 测试必须变红 → 按字节还原）。
- **技术选型有据可查**：哪些基础功能用库、哪些自己写、为什么，见
  [docs/技术选型-基础功能用库还是自己写.md](docs/技术选型-基础功能用库还是自己写.md)。
  其中三项已执行：**删掉零引用的 `zod` / `drizzle-orm`**、**把一直靠 Next 可选依赖活着的 `sharp` 显式声明**
  （`media/service.ts` 直接 import 它），并用"显式声明后构建仍通过"实测收尾。

**不能说的**：

- 不能说"P0 已实现"——第 2 节列的都是没做的。
- 不能说"已可上线"——**已经真的部署到一台 Linux VPS 上并跑通线上登录**（http://5.231.26.36，
  web+worker 双 systemd，见 [deploy/README.md](deploy/README.md)），但距离"可上线"仍差：
  **只有 HTTP**（会话凭证明文过网，靠显式降级开关换来的）、**没有备份**、没有防火墙、
  没上域名与 HTTPS、没有目录定时同步与发现。
- 不能说"外部审核已接入"——内置的只是**本地基础筛查**（默认还关着）；默认走人工，
  这**不是**"自动审核已完成"。
- 不能说"浏览器交互已自动化验收"——没有 Playwright；点过一遍的是**人工**，回归时不会自动重跑，
  且图片「插入图片」（系统文件选择器）始终没被浏览器驱动验证过。
- 不能说"审核已完备"——人工通过/需修改有了，但**站内没有授予/撤销管理员的界面**
  （必须上机跑 `scripts/grant-admin.mjs`）；举报、纠错、修订历史、搜索都还没做。
