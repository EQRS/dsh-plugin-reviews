# HANDOFF · 交接说明

> 最后更新：2026-10-18（线上按 docker compose 重建，见 §12）。这份文档描述**当前真实状态**：能跑什么、验过什么、没做什么。
> 配套文档：[`API端点与路径.md`](./API端点与路径.md)（接口清单）、[`docker约定.md`](./docker约定.md)（容器部署）。

## 1. 这是什么，现在什么状态

**DSH 插件测评站**：收录 DSH 插件、写/审/发评测、评论讨论的站内应用。
一条垂直薄片已经打通：**登录 → 收录插件 → 写评测 → 人工审核 → 发布 → 评论 → 通知**，
外加后台管理（待办审核、用户、配置、自动发现）、媒体（原图/展示图）、任务队列与 worker 自动发现。

| 项 | 现状 |
|---|---|
| 技术栈 | Next.js 16（App Router）+ React 19 + better-sqlite3（SQLite/WAL）+ TypeScript 7 |
| 运行形态 | 本地 `next dev`；生产 **Docker 四个角色**（migrate / web / worker / nginx 反代） |
| 代码规模 | 前端 42 文件、后端 80 文件、worker 4 文件、公共 7 文件、测试 29 文件 |
| 测试 | **30 文件 / 519 条全绿**（`npm test`） |
| 类型检查 | `pnpm typecheck` 通过，且开着 `noUnusedLocals` / `noUnusedParameters` |
| 迁移 | 到 `0009_review_verdict.sql`（编号执行、事务内、外键校验） |
| 已知线上 | **https://review.lingshulab.com**（Let’s Encrypt 证书，80 只做 301 跳转）。2026-10-18 跑 Docker 四角色（migrate / web / worker / nginx），数据在宿主 `/root/dsh-plugin-review/data`。⚠️ 该机 2026-10-17 被重装：**旧库、旧 `.env`、旧部署目录全部丢失**，现网从空库重建（见 §12） |
| 未上 | 备份（每日 03:00 恢复点）、只读 `GITHUB_TOKEN`、favicon 与错误页之类的细节 |

## 2. 关键路径

```
src/app/            页面与 API（App Router；29 个 route.ts）
src/components/     客户端组件（UI 全部走 globals.css，组件里不写硬编码颜色）
src/app/globals.css 全站视觉层：M3 令牌 → 基础 → 组件 → 手机端
src/server/packages 后端：platform（库/事务/日志/限流/媒体/健康检查）· modules（领域）· workflows
src/worker/         任务队列消费、自动发现排程、内容筛查
migrations/         带编号的 SQL 迁移
scripts/            验收脚本与运维小工具（自检、授权、发现、验收）
tests/              vitest（真实临时库 + 真实迁移，不用 :memory: 冒充）
docker/             容器资产（见 docker约定.md）
```

## 3. 跑起来

### 本地（开发）

```bash
cp .env.example .env.local          # 至少填 SESSION_SECRET（生产必须；本地可空）
pnpm install
pnpm dev                            # http://127.0.0.1:3100
pnpm test                           # 29 文件 / 506 条
pnpm typecheck
pnpm worker                         # 另开一个终端：任务与自动发现
```

本地要跑 HTTP 验收脚本时，需要测试登录通道：`.env.local` 里 `DSH_REVIEW_ALLOW_TEST_LOGIN=1`
（`next dev` 会强制 `NODE_ENV=development`，所以 `NODE_ENV=test` 那套判断拿不到值——这是踩过的坑）。

### 容器（部署）

见 [`docker约定.md`](./docker约定.md)。一句话：`cd docker && cp .env.example .env && docker compose up -d --build`，
对外只有 nginx（80/443），web/worker 在容器网络内。

### 常用运维

```bash
pnpm db:check                                        # 结构自检（表/索引/外键）
pnpm db:migrate                                      # 跑到最新迁移
node scripts/grant-admin.mjs <githubId>              # 指定管理员
DSH_ACCEPTANCE_BASE=http://127.0.0.1:3100 node scripts/acceptance-http.mjs
DSH_ACCEPTANCE_BASE=http://127.0.0.1:3100 node scripts/acceptance-catalog-browse.mjs
```

## 4. 已实现（按域，简表）

| 域 | 已做 |
|---|---|
| 身份 | GitHub OAuth（PKCE S256 + state + 浏览器绑定、一次性消费、return_path 限站内）、会话 Cookie、首个管理员引导、测试登录通道（双闸门） |
| 目录 | 收录检查（仓库可访问 **且** `dsh.bundle` **且** 配置文件存在）、按 (仓库, 路径) 幂等、`request_key` 去重、搜索/用途标签/是否有评测/排序/分页 |
| 评测 | 草稿（乐观并发 `saveVersion`）、提交 → 规则校验 → 内容筛查 → 人工审核 → 发布、修订快照不可改写、撤回、公开性判定单一真相 |
| 评论 | 顶层讨论组 + 回复、盖楼规则、可见性跟随内容、作者可改可删、频控（5 次/分/用户，合并计数） |
| 媒体 | 按真实字节鉴定类型、单张 ≤10MB、展示图（限长边、不放大）、原图仅本人可读、撤回后立刻不可读 |
| 通知 | 站内通知 + 未读数 + 标记已读 |
| 后台 | 待办审核（批准/要求修改，带 `stateVersion` 防覆盖）、用户角色与禁用、业务配置、自动发现手动触发 |
| 任务 | 执行权 CAS（token + running + 租约未过期）、重试周期、回收超期租约、按天幂等排程 |
| 可观测 | 结构化日志（含 `request_id`、真实 `client_ip`）、每请求一行访问日志、启动自检、worker 心跳、`/api/health`（可选含 worker） |
| 前端 | Material Design 3 设计体系（颜色/形状/动效/排版令牌）、桌面 + 手机两套版式、手机端侧边抽屉与底部导航、评测文章页（头图+标题融合、修订时间线、评论） |

## 5. 怎么验证"真的做完了"

本项目的验收纪律（这是从旧文档里保留下来的部分）：

1. **自己跑一遍，不信汇报里的数字**：`pnpm test` 的实际条数要跟文档一致。
2. **抽查最高风险声明**（挑"错了最致命"的那条，去**源码**里看，不只看测试）。例：
   - 明文凭证不入库 → 读 `identity/service.ts`：`newOpaqueToken()` → `digestText()`，查询按摘要进行；
   - 按 (仓库, 路径) 幂等 → 读 `catalog/service.ts`：先查后插。
3. **变异验证（anti-tautology）**：故意破坏一处实现，确认对应用例变红，再还原、复跑确认变绿。
   已固化为 `scripts/verify-tests-bite.mjs`（还有一组 `verify-*-bite.mjs`）。
   ⚠️ 教训：**破坏性实验的还原要逐条回读验证**，不能信 exit code（曾有还原静默失败、破坏代码留在文件里）。
4. **扫残留**：全仓找 `&& false`、`.bak`、`*mutation*`、临时破坏注释。
5. **不装作成功**：未做的功能不回 200、不给假数据；未验证的事在文档里写明"未验证"（见 `docker约定.md` §8）。

最近一次（2026-10-17）的实测结果：

| 检查 | 结果 |
|---|---|
| `pnpm test` | 29 文件 / **506 条通过** |
| `pnpm typecheck` | 通过（含未使用声明检查） |
| HTTP 验收 | **16/16** |
| 目录浏览验收 | **10/10** |
| 生产构建 | 在隔离目录 `next build`（webpack）通过，路由清单与开发一致 |
| 页面视觉 | 13 类页面 × 5 档宽度共 65 组布局/样式快照逐项一致；截图仅"上次登录时间"这类真实数据差异 |
| 动效 | 入场/一次性摘类/按压涟漪/减少动效四项行为符合预期 |

## 6. 已知缺口（**没做**的，别误以为有）

| 缺口 | 说明 |
|---|---|
| 全文检索 | 现在只有 `LIKE` 搜索（已做通配符转义）。规划里的 FTS5 未做 |
| 收藏 / 有用投票 | 连表都没有 |
| 整合包（packs）/ 批量导入投稿 | 连表都没有；`/packs` 不存在 |
| 备份恢复界面 | 只能用命令行备份（见 `docker约定.md` §6） |
| 媒体多尺寸 | 只有 `original` + `display` 两个变体 |
| 真实内容审核 | `basic` 是本地确定性词表，**仅演示**；生产必须换真实供应商 |
| 后台剩余组 | 站点设置还有项未接进后台（部分参数仍写在代码常量里） |
| TLS | 未配置；相关降级项必须在上 HTTPS 后删除 |
| worker 编译产物 | worker 直接跑 TS（`tsx`），所以镜像含着 devDependencies（约 1.3GB）。要瘦身得先给它做编译产物 |
| 审计/风控 | 频控按用户计，**不按 IP**；`client_ip` 只进日志，未参与任何判定 |

## 7. 几条不改的规矩（改之前先看理由）

- **组件里不出现硬编码颜色**：一律 `var(--…)`，换肤只改 `globals.css`。
- **正文必须过 `rehype-sanitize`**：用户输入永不直接进 HTML（`markdown.ts`）。
- **可见性只有一个真相**：`resolveVisibilityInTx`（撤回/隐藏/未发布都在那里判定）。
- **错误码与状态码稳定**，中文文案可改；前端按 `code` 分支，不匹配文案。
- **迁移是向前、编号、事务内**；不写"先收录再说"这类宽松路径。
- **未配置外部依赖时明确报错，不伪装可用**（GitHub 登录、内容筛查都是这个口径）。

## 8. 关于旧文档

主人的要求是清空 `docs/`，现在这里只剩三份：本文、`API端点与路径.md`、`docker约定.md`。

- 旧的设计稿（《架构设计》《模块签名契约》《并行工作包》《切片说明》《验收纪律》《部署-README》等）
  **已删除**，需要时用 git 历史找回：`git log --diff-filter=D --name-only -- docs` 或
  `git show <删除前的提交>:docs/架构设计.md`。
- 源码注释里仍会看到 `架构第 N 节`、`docs/…` 这类**历史引用**，它们指向的就是上面那些已删除的设计稿；
  正文的"为什么"都写在代码注释里，不依赖那些文档才能读懂。
---

## 12. 2026-10-18：线上按 docker compose 重建（含当日 4 个修复）

### 12.1 发生了什么

这台 VPS 在 **2026-10-17 07:46 被重装过**（`/` 的时间戳、`/srv` 为空、无 `dsh-review-*` systemd
单元、无容器无镜像、磁盘只用 1.4G）。判断依据是实测：`/srv/dsh-plugin-review` 不存在、
`find / -name app.sqlite` 只找到当天新建的那个。

**因此：旧的数据库（17 个插件、评测、评论、用户）、旧 `.env`（OAuth/SESSION_SECRET）全部丢失。**
现网是**从空库重新建的**。若 VPS 服务商有 10-17 之前的快照，可以按 §12.4 的步骤把旧库接回来。

### 12.2 当天修的四个缺陷（都已入库）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | `scripts/acceptance-http-write.mjs` 提交不带判定 | PR#4 合入后 `input_invalid`，随后 `:152` TypeError，后面十几条检查全跑不到 | 提交体补 `verdict: 'undetermined'` |
| 2 | `scripts/seed-demo.mjs` 同上 | 演示数据造不出来 | 补 `verdict: 'helpful'` + 一条 `evidenceRefs` |
| 3 | `docker/daemon.json` 带 `_comment` 键 | `dockerd` **起不来**：`directives don't match any configuration option: _comment` | 改成纯配置；说明移进 `docs/docker约定.md` 并加警告 |
| 4 | `docker/web.Dockerfile` 的 builder 没 COPY `server.mjs` | 镜像构建必失败：`"/app/server.mjs": not found`（只有 nginx 镜像能成） | builder 补 `COPY server.mjs ./` |

> 3、4 是"照着 `docker约定.md` 与 `compose.yaml` 走一遍就必然撞到"的问题 —— **容器化这套此前从未真正构建过**。

### 12.3 当前线上形态

```
/root/dsh-plugin-review/
├─ repo/            ← git archive 上传解包（不是 git clone；私库不便在服务器留凭据）
│  └─ docker/.env   ← 600，含 SESSION_SECRET（新生成）/ OAuth / BOOTSTRAP_ADMIN_GITHUB_ID
├─ data/            ← app.sqlite + media（属主 10001:10001）
└─ certs/           ← 空（TLS 未配）
```

* 容器：`migrate`（Exited 0）/ `web`（healthy）/ `worker`（healthy）/ `nginx`（healthy，80+443 已发布）
* 库结构：`0009_review_verdict.sql`；`selfcheck` → `missingTables: []`、`problems: []`
* TLS：`https://review.lingshulab.com`（Let’s Encrypt，2027-01-16 到期，`certbot.timer` 自动续期；
  续期后由 `/etc/letsencrypt/renewal-hooks/deploy/dsh-review-nginx.sh` 把证书搬进
  `/root/dsh-plugin-review/certs` 并 reload nginx）。80 全量 301 到 HTTPS。
* 部署参数：`DSH_REVIEW_ALLOW_TEST_LOGIN=0`（**公网必须关**）、`DSH_REVIEW_CONTENT_SCREEN=basic`、
  `DSH_REVIEW_TRUST_PROXY=1`（compose 里给 web）、无 `GITHUB_TOKEN`（未决，见 §12.5）
* 首轮自动发现：worker 启动即排当天任务，`searched_repos=60 plugins_found=4 accepted=4`，
  因**未认证 60 次/小时**而上限收尾（`requests_used=58`）

### 12.4 如果要接回旧库

1. 从服务商快照/备份取回旧 `app.sqlite`（旧结构是 `0008`）；
2. 停 `web`/`worker`：`docker compose stop web worker`；
3. 覆盖 `/root/dsh-plugin-review/data/app.sqlite`（连带删掉 `-wal`/`-shm`），`chown 10001:10001`；
4. `docker compose run --rm migrate`（会把 0008 → 0009 补齐并自检）；
5. `docker compose up -d`，核对 `/api/health` 的 `schema_version` 与站内数据。

### 12.5 待主人做的两件事

1. **GitHub OAuth 回调（唯一还挡着登录的一步，只能在 GitHub 后台改）**：
   站点发出的 `redirect_uri` 已经是 `https://review.lingshulab.com/api/auth/github/callback`
   （Client ID `Ov23liMF9kujrLNxhBZ3`，App 名 `dsh-plugin-review-dev`）。
   请到 GitHub → Settings → Developer settings → OAuth Apps → 该 App，把
   **Authorization callback URL** 改成这个地址（Homepage URL 建议同步改成 `https://review.lingshulab.com`）。
   改完直接点站点右上角「登录」即可。
2. **首个管理员**：`BOOTSTRAP_ADMIN_GITHUB_ID` 已按本地配置写入；**当站内一个管理员都没有时**，
   该 GitHub 数字 ID 首次登录即被提升为管理员（用户名不算数，只看数字 ID）。
3. （可选）加只读 `GITHUB_TOKEN`：单轮发现从约 4 个提到约 30 个候选、请求预算 58 → 400。

---

## 13. 2026-10-18（第三轮）：备份恢复点 + 首次填充插件库

### 13.1 备份（`参数与管理规则.md §81`，此前"一份备份都没有"）

* `scripts/backup.mjs`：SQLite **在线热备**（`db.backup()`；WAL 下 `cp` 会漏未 checkpoint 的事务）
  + 媒体打包 + `manifest.json`（schema / 各表行数 / integrity / sha256 / 耗时），**生成后当场自检**，
  不合格退出码非 0；保留最近 14 份。
* `scripts/restore-backup.mjs`：**先验后写** —— sha256 不符 / 副本完整性不过 → 拒绝；
  写回前把现库改名 `app.sqlite.before-restore-<ts>`（不删）；媒体需显式 `--media`。
* 落点：`/root/dsh-plugin-review/backups/`（**与数据目录分开挂载**，数据出问题时备份还在）。
* 定时：`dsh-review-backup.timer`（`OnCalendar=03:00` + `Persistent=true` + 5min 随机偏移），
  执行 `docker compose run --rm --no-deps web node scripts/backup.mjs --label auto --keep 14`。
* 手动：后台「存储与备份」组 → 「立即备份」（`POST /api/admin/backups`，与定时同一脚本）。
* 演练：`tests/backup.test.ts` 6 条（真跑脚本）—— 清单与行数一致、篡改一个字节被 sha256 拒绝、
  未加 `--force` 不覆盖、保留策略、库缺失时明确失败；线上首次手动备份实测
  `592 KB / integrity ok / users=13 plugins=9`。
* ⚠️ 同机备份**不防整机丢失**；异地副本仍要自己定期拉走（见 `docs/备份与恢复.md` §6）。

### 13.2 首次填充插件库

* 现状：9 → **21** 个插件（一轮 `dsh plugin in:description` 捞出 12 个，单轮只花 26 次核心请求）。
* 机制：`dsh-review-discovery-drip.timer` 每 **40 分钟**排一轮，轮换 5 个搜索词
  （`topic:dsh-plugin` / `dsh-plugin in:name` / `topic:deepseek-harness` / `dsh plugin in:description` / `topic:dsh`）。
  40 分钟节拍 ≈ 39 次核心请求/小时，安全压在未认证的 60/h 之下。
* 只**排任务**，探测与收录仍由常驻 worker 执行（与每日定时同一条路径）。填满后：
  `systemctl disable --now dsh-review-discovery-drip.timer`。
* 未认证上限仍在：如果加一个只读 `GITHUB_TOKEN`，可以一次性批量跑完（无需等 40 分钟节拍）。
* 实测：第二轮 `topic:deepseek-harness` 因配额被第一轮吃满而 `HTTP 403` —— 处理器把它判为
  **限流**并保留已收录结果（不是失败、也不会清空数据）。

### 13.3 当日踩坑：`.gitignore` 的 `backups/` 把接口目录一起忽略了

加备份功能时在 `.gitignore` 写了 `backups/`（想忽略备份产物），没带前导斜杠 ——
gitignore 的目录规则匹配**任意层级**，于是 `src/app/api/admin/backups/route.ts` 被静默忽略：
本地 typecheck / build 全过（文件在磁盘上），提交里却没有它，部署后 `/api/admin/backups` 直接 **404**。

修法：改成 `/backups/`（只忽略仓库根那一个），并在 `.gitignore` 里留注释说明。
教训：`git status` 里**没看到**新文件时别默认"忘了 add"，先 `git check-ignore -v <path>` 问一句。

---

## 14. 2026-10-19：用途分类（topics → 中文分类，计数改 distinct repository）

### 14.1 起因（线上实测的三个问题）

* chip 行直接拿 GitHub topics 当标签：`dsh-plugin` 覆盖 46/50、`deepseek-harness` 40/50 —— 没有区分度；
* 仓库级 topics 被复制到该仓库每个插件：`hyzyn/dsh-plugin-kit` 一个仓库 11 个 packages，
  让 `docker`/`rss`/`ftp`/`ssh` 各 +11，计数被单仓放大；
* 标签是英文原样，没有中文口径。

### 14.2 做了什么

| 动作 | 落点 |
|---|---|
| 新表 `plugin_categories`（slug/label/topics/sort_order/is_visible）+ 10 个种子分类 | `migrations/0010_plugin_categories.sql` |
| 分类聚合：**distinct repository** 计数 + 「未分类」算出来 | `catalog/service.ts` `listCategories()` |
| 筛选：`?cat=<slug>`（`__none__` = 未命中任何分类）；原始 `?tag=` 仍保留（旧链接兼容） | `buildDirectoryWhere()` |
| 插件条目带分类展示名（按仓库批量取，避免 N+1） | `categoriesByRepository()` |
| 原始 topics 视角 + 是否被认领（后台"待归类"） | `listTopicUsage()` |
| 后台「分类管理」：增删改、重名校验、点选未归类 topic 入草稿 | `/api/admin/categories` + `admin-category-panel.tsx` |
| 页面：首页 chip、目录左栏、卡片、详情页（分类为主、原始 topics 降为小字） | `app/page.tsx`、`app/plugins/**` |
| 文档 | `docs/分类与标签.md` |

### 14.3 口径与边界

* **分类 = 多对多视图**，不是互斥分区；一个 topic 被两个分类认领时插件同时出现在两处。
* **计数按仓库**（`repositoryCount`），同时保留 `pluginCount` 供后台对照 —— 首页/左栏显示前者。
* 「未分类」两个概念别混：`__none__`（有 topics 但没被认领 → 运营待办）vs
  `UNCLASSIFIED_TAG`（没有 topics → 抓取缺失）。
* 分类是**仓库级**的：同一仓库的多个 packages 共享同一组分类；插件级分类不在本切片。
* 分类重名被**拒绝**（不自动改名）；隐藏的分类不参与筛选、不进 chip，但后台可见。

### 14.4 验证

* `tests/plugin-categories.test.ts` 8 条：monorepo 不放大计数、噪声不进 chip、未分类是算出来的、
  同一仓库多插件共享分类且不重复、按分类/未分类筛选、隐藏分类、增删改、五类非法输入、种子数据自检。
* 全量 **533 测试 / 32 文件**；`tsc` 干净；`build` exit 0。

> 踩坑记录：测试里用真实词汇（memory/rag/docker）当数据会**撞上种子分类的认领关系**，
> 第一版测试因此把"未分类"断言写错。测试数据一律用 `zz` 前缀隔离。

---

## 15. 2026-10-20：P1 互动三件套（有帮助 / 收藏 / 举报）

### 15.1 做了什么

| 功能 | 落点 |
|---|---|
| **有帮助**（一人一票、可取消） | 迁移 `0012` `review_helpful_votes`；`POST/GET /api/reviews/[id]/helpful`；详情页按钮 |
| **收藏**（插件；整合包等 P4） | `plugin_favorites`；`GET/POST /api/me/favorites`；`/me/favorites` 页 + `me-nav` 新栏目 + 详情页按钮 |
| **举报**（评测/评论；整合包版本等 P4） | `reports` + `report_handling_records`；`POST /api/reports`（频控 `rate_limits.reports_per_hour`=20 可调）；评测详情与评论区各有入口 |
| **举报处理** | 后台「举报处理」组：隐藏 / 驳回 / 要求补充证据，原因必填；隐藏会真隐藏（评测走 `content_entities`，评论走新增的 `comments.hidden_*` 三列） |
| **处理结果通知** | 迁移 `0013` 重建 `notifications`：`kind` 增 `moderation_result`、`comment_id` 可空、新增 `detail`；处理时通知举报人（隐藏时也通知作者） |

### 15.2 关键设计点

* **评论隐藏不复用 `deleted_at`**：作者删除是"本人撤下"（有回复留占位），管理员隐藏是"违规处理"（整条不展示）。
  三个隐藏列"同生共死"由触发器钉住（`trg_comments_hidden_triplet_update`）。
* **计数不落冗余列**：有帮助数始终 `COUNT(*)`；实测量级下比维护计数列更省心。
* **举报去重做成部分唯一索引**：同一人 + 目标 + 原因只允许一条 `state='open'`，处理完后可以再举报。
* **通知的"哪种类型该带什么"写成 CHECK**：评论类必须带 `comment_id`，`moderation_result` 必须带 `detail`。

### 15.3 验证

* `tests/interactions.test.ts` 8 条：一人一票/可取消、匿名 401、未公开不能投票、收藏切换与列表、
  举报去重、未公开不能举报、隐藏后内容真的不可见 + 两条通知 + 处理记录、重复处理冲突、评论隐藏后整条消失。
* 全量 **549 测试 / 35 文件**；`tsc` 干净；`build` exit 0。
* 迁移先在库副本演练：`applied [0012, 0013]`、`foreignKeyCheck: []`、通知表重建后历史 3 条保留、索引齐全。

### 15.4 仍未做（P2 之后）

评测搜索、资料纠错、整合包（含整合包收藏/举报/审核）、审核结果通知、操作记录查询界面。

---

## 16. 2026-10-20：P2 评测搜索（FTS5 混合检索）

### 16.1 为什么是「混合」检索

SQLite FTS5 默认分词（unicode61）对中文是「整段一个词」，子串搜不到；trigram 分词能做子串，
但**只对 ≥3 字符的查询生效**（实测「中文检」命中、「记忆」这种 2 字返回 0 条）。

所以检索层分两条路（`src/server/modules/search/index.ts`）：

| 查询长度 | 走哪条 | 排序 |
|---|---|---|
| ≥3 字符 | FTS5 MATCH（phrase）+ bm25 | 相关度（标题 8 / 正文 1 / 插件名 4） |
| 1–2 字符 | LIKE 子串回退（标题/正文/插件名） | 发布时间倒序 |
| 空 | 全量公开评测 | 发布时间倒序 |

两条路都只返回当前公开的评测：不复制可见性判据，统一调 `resolveVisibilityInTx`，
撤回/隐藏生效时检索结果自动跟着变（有测试钉住：索引行还在，但结果里没有）。

### 16.2 索引维护

* 迁移 `0014_review_search.sql` 建 FTS5 虚表 `review_search(review_id UNINDEXED, title, body, plugin_name, tokenize=trigram)`；
* **发布事务内**写入（`workflows/publish-review` 调 `reindexReviewInTx`）—— 索引与公开修订指针同生共死；
* 撤回/隐藏不删索引（查询时判可见性），所以不会出现「搜得到但打不开」；
* `scripts/backfill-review-search.mjs` 回填已发布评测（幂等）；线上本次回填 **76 篇**。

### 16.3 页面与插件搜索

* `/reviews`：搜索框 + 来源筛选 + 用途分类筛选（与目录同一套 plugin_categories）+ 每条显示被测版本；条件留在 URL；两种空状态文案分开；
* 插件搜索按匹配程度排序：名称全等 > 名称前缀 > 仓库名前缀 > 其它，再按更新时间/评测数。

### 16.4 验证

* `tests/review-search.test.ts` 6 条：FTS 与 LIKE 两条路、撤回后搜不到（索引行仍在）、来源+分类组合、
  标题命中排前、索引幂等、插件相关度顺序；
* 全量 **555 测试 / 36 文件**；tsc 干净；build exit 0；
* 线上：schema 0014、回填 76 篇、`/reviews?q=记忆` 与 `?q=检索测` 都能出结果、分类/来源筛选 200。

---

## 17. 2026-10-20：P3 资料纠错（迁移 0015 + 0016）

### 17.1 核心不变量：同步值与修正值分开存

* `plugins.display_name / description` **永远是 GitHub 同步来的原值**；
* 管理员采纳的修正进 `plugin_field_overrides`（UNIQUE(plugin_id, field_key)）；读取时合并（列表一次批量取）；
* **收录/刷新时跳过被覆盖的字段** —— 否则下一次同步会把修正冲掉，而 override 表里的"谁改的、为什么"还留着，
  数据与记录就对不上。测试里专门有一条"采纳之后再跑一次同步"钉住它；
* 「恢复同步资料」= 删一行 override，不需要重新探测 GitHub。

### 17.2 为什么通知表要放开一个约束（迁移 0016）

插件不是 `content_entities` 的一行，而 0013 里通知的 `content_entity_id` 是 NOT NULL。
0016 放开为可空，并用 CHECK 写死：**只有 `moderation_result` 允许为空**；评论类通知仍然必须有 comment_id 与内容锚点。

### 17.3 字段白名单与边界

只允许纠 `display_name` / `description`；分类（topics）是仓库级的，改一个会波及其它插件，留给后续单独设计。

### 17.4 验证

* `tests/plugin-corrections.test.ts` 5 条：提交去重、五类非法输入、采纳后展示修正值 + 处理记录 +
  通知（空锚点）、重复处理冲突/越权、**采纳后再同步不覆盖**（含列表页合并覆盖值）；
* 全量 **574 测试 / 38 文件**；tsc 干净；build exit 0；
* 副本演练 0015+0016：foreignKeyCheck 空、通知保留、空锚点可写、评论类缺 comment_id 被 CHECK 拒绝；
* 线上：schema 0016、`POST /api/plugins/{id}/corrections` 匿名 401、`GET /api/admin/corrections` 匿名 403。
