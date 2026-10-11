# DSH Plugin Review · 最小功能切片

> **这条切片做完了什么、没做什么，都在本文件里。**
> 请先读第 2 节「未按文档实现」——它和代码一样是交付物的一部分。

切片范围（主人确认）：**登录 → 收录插件 → 写／审／发一篇评测 → 评论**。

---

## 1. 怎么跑

```bash
npm install
npm run db:migrate      # 建库 + 应用迁移（19 张表 + 16 个触发器）
npm run db:check        # 启动自检：外键、WAL、表齐全、schema 版本
npm run dev             # Web：http://127.0.0.1:3100
npm run worker          # 独立 worker 进程（可选）
npm test                # 221 个测试
npm run typecheck       # tsc --noEmit
```

### 验收脚本（真跑，不是描述）

| 命令 | 做什么 | 当前结果 |
|---|---|---|
| `npx vitest run` | 单元 + 集成 + 端到端（含真实临时库与真实迁移） | **221 passed / 9 files** |
| `npx tsc --noEmit` | 类型检查 | **exit 0** |
| `node scripts/verify-tests-bite.mjs` | **反恒真自检**：删掉盖楼触发器 → 测试必须变红 → 还原 → 必须复绿 | 通过 |
| `node scripts/verify-comment-visibility-bite.mjs` | **反恒真自检**：去掉评论公开修订过滤 → 评论可见性测试必须变红 → 还原（逐字节核对）→ 必须复绿 | 通过 |
| `node scripts/acceptance-http.mjs` | 对**运行中的 dev server** 做 HTTP 验收（需先 `npm run dev`） | **14/14** |
| `npx tsx scripts/acceptance-http-write.mjs` | HTTP 写入链路：登录→建草稿→保存→提交→管理员通过→发布→公开可读→评论→撤回 | **18/18** |
| `npx tsx scripts/seed-demo.mjs` | 造一条保持公开的演示评测（用于看页面真实渲染） | 见下 |
| `node scripts/verify-node-cpsync.mjs` | 复核本机 Node 的 `cpSync` CJK 崩溃（环境坑，与本项目功能无关） | 见 `docs/环境坑-cpSync-CJK崩溃.md` |

> `acceptance-http*.mjs` 需要 dev server 在跑；它们走真实 HTTP，不是调用函数。
> 两者都**不假设库里没有别的数据**（早先版本假设为空，被演示数据干扰过，已修）。

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
| 图片与附件上传、存储源迁移 | 需求 §6；架构 §10、§45—47 | 评测只能是纯文本 |
| 批量导入、集中投稿、公平队列 | 需求 §25；架构 §72、§73 | 无 `/me/batches` |
| 备份与恢复 | 架构 §28、§54 | 无备份入口 |
| AI 内容筛查 | 需求 §9；架构 §20 | **未配置即不自动放行**，提交停在 `manual_review`（这是刻意保留的正确行为，不是缺陷） |
| 真实 GitHub OAuth 往返 | 架构 §11；部署 §5 | 见 2.2 |
| 真实 GitHub 目录读取 / 同步 | 需求 §1；架构 §92—99 | 见 2.2 |
| 管理员后台的完整栏目 | 需求 §23；架构 §90、§91 | 只有"待办列表 + 人工决定" |
| 修订历史查看、旧版对比 | 需求 §10 | 快照保留在库里，但**没有读取界面** |
| Docker / Compose / Linux 构建 | 部署 §1—3 | 只验证了本机 Windows + Node 24 |

### 2.2 外部依赖的真实状态（**不伪装可用**）

| 外部能力 | 当前行为 |
|---|---|
| GitHub OAuth | **未接入**。生产环境 `POST /api/session` 直接返回 `provider_not_configured`；开发环境提供**测试登录通道**（用身份桩建会话），响应里带 `note` 明确标注"真实 GitHub OAuth 尚未接入" |
| GitHub 收录检查 | `CatalogProbe` 接口已定义且实现完整，但**未接真实出网调用**。`POST /api/plugins` 返回 `provider_not_configured`，**绝不放行收录** |
| 内容筛查 | 未配置 → 提交转 `manual_review`，**绝不自动放行、也不认定违规** |

### 2.3 已知的实现偏离（有意的）

| # | 偏离 | 原因与影响 |
|---|---|---|
| 1 | **迁移用新手写 SQL + `schema_migrations` 表**，不是 Drizzle-Kit 生成流水线 | 本切片需要延迟外键、联合唯一、部分唯一索引、行内 CHECK 与跨行触发器，Drizzle 生成器表达不稳。**权威结构是 `migrations/*.sql`** |
| 2 | `drizzle-orm` **只作为依赖存在，未在业务代码中使用** | 业务查询直接走 better-sqlite3 参数化语句。契约第 97 行要求"不暴露 Drizzle 查询对象"这一点是满足的 |
| 3 | 业务参数写成**模块内常量**，未接配置服务 | `site_settings` / `configuration_revisions` 表已建但仅留位。文档（需求 §24、架构 §12/§50）要求后台可调 + 版本快照 + 审计 |
| 4 | **评论入队在业务事务之后**（架构 §78.1 要求"同一事务"） | `withTransaction` 回调必须同步，而 tasks 加载是异步的。评论已建但入队失败会**显式抛错**让调用方重试，不静默吞 |
| 5 | `hide` / `unhide` / `withdraw` **未写 `operation_records` 去重** | 幂等目前只覆盖：草稿保存、提交、插件收录三处 |
| 6 | worker 的 **handlers 注册表为空** | `review_check` / `review_publish` 的真实处理器应在 workflows 层装配，尚未接。未注册类型记为 `skipped` + `no_handler`，**不假装成功**。**直接后果**：① 评论创建后停在 `pending`，不会自动出现在公开列表（HTTP 验收里按这个真实契约断言）；② 评测发布由 `workflows/publish-review.ts` 提供，但**没有自动触发者**（验收脚本里是显式调用） |
| 7 | 会话 Cookie 在**开发环境不带 `__Host-` 前缀** | `__Host-` 强制要求 `Secure`，http 下浏览器/curl 会直接丢弃 → 表现为"登录 200 但立刻匿名"。生产环境仍用 `__Host-dsh_session`，见 `platform/session-cookie.ts` |
| 8 | `parseSubmissionUrl` 对 `branch` 含 `/` 有**固有歧义** | 按"第一段为分支、其余为路径"处理，注释已写明；建议用 40 位 commit SHA 永久链接 |
| 9 | **公开列表/详情页没有关键词搜索与筛选** | 需求 §16—18 要求搜索、分类筛选、排序；本切片只做分页 + 公开资格过滤 |
| 10 | 页面**没有登录入口与编辑器表单** | `/me` 提示可用 `POST /api/session`；写评测目前走 API（验收脚本就是这么跑的）。页面是"链路看得见"的载体，不是完整交互 |

### 2.4 测试覆盖的真实边界（**不要高估**）

- `runRuleCheck` 的「标题非空」「插件未绑定」两条分支**无法做集成测试**：库里 `review_revisions.title` 有 `CHECK(trim(title)<>'')`、`plugin_id` 是 NOT NULL 外键，这两种缺项**落不了库**。这两条只由纯函数 `evaluateRules` 覆盖。
  **没有**为了让测试覆盖而放宽表约束——约束是防线，价值高于覆盖率数字。
- 跨**进程**并发抢任务未实测：单测在同连接上用 `Promise.all`，依赖 `UPDATE` 的原子 WHERE 条件。
- `MAX_CONCURRENT_TASKS=4` 的"同时运行"语义只断言了"一轮最多领 4 条"，未做真实并发压测。
- 未做浏览器交互验收（无 Playwright）；页面只做了 HTTP 200 与真实数据渲染检查。

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

> 第 13 条值得单独说明：它同时暴露了两件事——
> ① 公开读取漏了可见性过滤（**真实漏洞**，会泄露尚未通过检查的内容）；
> ② 评论创建后**没有任何东西把它发布**（本切片只做了 `comment_check` 入队，没有评论发布处理器，
> 因为 worker 的 handlers 注册表是空的，见 §2.3 第 6 条）。
> 所以现在评论创建后停在 `pending`，公开列表里看不到 —— **这是"未实现"，不是"坏了"**。
> 修好过滤后，行为从"错误地可见"变成"正确地不可见"，两者不能混为一谈。

---

## 6. 代码地图

```
migrations/            0001_baseline.sql（19 表）/ 0002_triggers.sql（16 触发器）—— 权威结构
src/packages/common/   错误码、结果与分页、字段规则、状态文案（浏览器可用）
src/server/platform/   db / tx / time / id / digest / log / context / migrate / errors-http / request-id / session-cookie
src/server/modules/    identity · catalog · reviews · content · comments · moderation · tasks · operations
src/server/workflows/  submit-review · publish-review（跨模块协调事务）
src/server/adapters/   login（GitHub 骨架 + 测试通道）
src/app/               App Router：页面 + /api 路由
src/worker/main.ts     独立任务进程
tests/                 218 个测试（含 support/db.ts 真实临时库）
scripts/               验收与自检脚本
docs/                  设计映射、并行分组协议、模块签名契约、验收纪律、环境坑
```

配套文档：
- [最小切片-设计映射.md](docs/最小切片-设计映射.md) —— 每条实现 ↔ 文档章节
- [验收纪律.md](docs/验收纪律.md) —— 怎么判断"真的做完了"
- [模块签名契约.md](docs/模块签名契约.md) —— 并行接口与主控裁决记录
- [环境坑-cpSync-CJK崩溃.md](docs/环境坑-cpSync-CJK崩溃.md) —— 本机 Node 的一个真实坑

---

## 7. 结论口径

**可以说的**：这条垂直链路在本机真实跑通了（218 单测 + 14 项 HTTP 读验收 + 17 项 HTTP 写验收），核心不变量有真实约束与反恒真测试兜底。

**不能说的**：
- 不能说"P0 已实现"——上面第 2 节列的都是没做的。
- 不能说"已可上线"——没有 Linux/Docker 构建、没有真实 OAuth、没有真实 GitHub 收录、没有备份恢复演练。
- 不能说"外部审核已接入"——未配置时走人工，这**不是**"自动审核已完成"。
