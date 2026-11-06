# PR：讨论区（forum）—— 含复审修复

分支 `feat/forum` → `main`。**已在 `685c6a9`（含 #43 精选订阅与 #46 问题反馈）之上 rebase。**

---

## 先说结论

给站点补一个**用户之间对话**的场所：分区 + 帖子 + 两层回复 + 点赞 + 收藏，外加分区申请与后台审核。
收藏重构（三类内容共用收藏夹）**不在本 PR**，是独立的 PR B。

本 PR 含两部分：
1. **讨论区主体**（此前已经过一次完整审查）
2. **复审修复**——针对上一轮审查的 8 条严重 + 12 条中等问题的逐条整改

## 复审修复了什么

上一轮审查的结论是「建议修改后再合」。这里逐条对应：

### 四条「看起来做了、实际没生效」

| 问题 | 根因 | 现在 |
|---|---|---|
| **带图发帖必然失败** | 前端把 `attachments.id` 当成 `attachment_files.id` 传给后端；两者是不同的主键，外键挡住后被触发器转成 ABORT，用户看到 500 | 新增 `resolveAttachmentFileIds` 在写入前解析 id，前端改传 `displayFileId`，表单补上 `onUploaded` |
| **论坛图片对非上传者一律 404** | 媒体读取白名单只认评测引用，讨论区零命中 | 补 `isForumPubliclyReferenced`：帖子/回复已发布且分区未归档即可读 display 变体 |
| **举报去重索引全部失效** | 四个目标列平铺进同一个唯一键，而 CHECK 保证恰好一列非空；SQLite 视 NULL 互不相等 → 五类目标全失效。且重建表连带删掉了 0012 的有效索引 | 按 `target_kind` 拆成四条部分唯一索引，恢复并扩展既有去重 |
| **`forum.enabled` 只关了页面** | 接口完全不查开关 | 补到 15 个路由文件的 24 个 handler，先于鉴权返回 404；导航入口按开关隐藏 |

### 其余四条严重项

- **数据泄露**：已删除与待审帖子的正文可以从匿名 GET 直接读出来；已删除回复的正文能从匿名列表接口批量拿到。新增统一判权，越权返回脱敏对象（保留痕迹、不失入口）。
- **`reports.detail` 上限不一致**：迁移收到 1000，接口与 UI 仍是 2000，中间区间撞 CHECK 抛 500；老库有超长行会让迁移中止。改回 2000。
- **编辑绕过审核**：先发干净帖再改成违禁内容即可。`editPost` 现在复用 `screenPost`，同事务写审核记录。

### 迁移冲突（本次 rebase 的重点）

原 0037 重建 `notifications` 时用的是 0016 的旧口径，而 #43 的 0034 已经加了 `link_url` 列与 `featured_published` kind、0036 又加了 `feedback_result`。迁移按文件名排序，0037 永远在它们之后执行，结果是**静默丢列丢 kind**；老库里若已有这两类通知行，COPY 还会撞 CHECK 让迁移中断。

现改为取并集：kind 八项、补 `link_url`、相关组合 CHECK 扩到六种栏目类 kind、INSERT 列清单补 `link_url`。

### 十二条中等问题

评论举报按 `comment_id` 去重（此前落到 `content_entity_id`，同内容下两条评论互相挤占）；隐藏回复补减 `reply_count`；协管编辑他人帖子收回（设计只给协管软删与置顶）；草稿补 100 条上限、`total` 取真实计数、PATCH 改为部分更新；建帖与删草稿并入同一事务；分区管理补后台 API；匿名列表不再在读路径写库；讨论区通知可跳转（`forum_board_application` 死 kind 接上）；撤销 owner 时清空 `owner_id`；`REQUIRED_TABLES` 补登 13 张 forum 表。

---

## 主要内容

### 迁移

- **0037**：分区 / 区长协管 / 白黑名单 / 帖子 / 两层回复 / 点赞 / 分区申请 / 附件引用共 10 张表 + 4 个触发器；重建 `notifications` 增加三种 kind；种子两个默认分区。
- **0038**：发帖草稿与自动审核记录；重建 `reports` 支持讨论区两类目标。

**触发器兜底**（不靠应用层自觉）：回复只有两层；回复的回复不能挂附件；附件只能引用本人上传的文件。

### 服务层

分区权限（`everyone` / `whitelist` / `admin_only` 三态 + 黑名单叠加）、两层回复、软删、点赞幂等、发帖自动审核、草稿、分区申请与审核。

发帖策略的判定顺序：站方管理员 → 分区 owner → 命中 deny 拒绝 → whitelist 且不在 allow 拒绝 → admin_only 拒绝 → 放行。**createPost 与 createReply 共用同一份判定**，不复制规则。

### 页面

`/forum` 分区列表、`/forum/{slug}` 帖子列表（最新发布 / 最后回复可切，置顶优先）、`/forum/{slug}/{postId}` 帖子详情与两层回复、`/forum/new`、`/forum/{slug}/{postId}/edit`、`/forum/applications`、`/admin/forum` 后台、个人中心「我的帖子」。

### 通知与限流

新增 `forum_reply` / `forum_reply_to_reply` / `forum_board_application` 三类通知；限流新增发帖 10/时、回复 30/时、分区申请 3/天。

---

## 验证

```
tsc --noEmit        → 0 错误
vitest run          → 80 文件 / 931 用例全绿（212.8 秒）
```

本次新增测试 4 个文件：`forum-visibility`（16 项，五视角判权）、`forum-attachments`（10 项，附件 id 契约与图片可读性）、`forum-misc`（26 项）、`migrations-forum-union`（8 项，迁移结构与上游口径一致性）。

**迁移冲突有实测证据**：用真实的 `origin/main` 迁移链跑对照实验，确认修复前 `link_url` 与两个 kind 会被静默删掉、修复后存量 `featured_published` 行迁移完好保留。

---

## 已知缺口（如实列出）

1. **分区管理只有 API，没有 UI**。白黑名单、任命协管、归档、转移 owner 服务层与后台接口都已实现，但后台没有对应页面，目前只能通过接口调用。
2. **两处通知锚点从去重键解析**。迁移 0037 的 CHECK 规定讨论区通知的 `comment_id` 与 `content_entity_id` 必须为 NULL，所以回复锚点只能从去重键 `forum_reply:{replyId}:{recipient}` 还原。若日后想要独立锚点列，需要单独加迁移。
3. **回复的编辑 / 删除 UI 未做**。服务层有 `deleteReply`，页面没有入口。
4. **后台没有待审帖放行页面**。发帖自动审核挡下来的帖子目前没有人工复审入口（`editPost` 改写为干净内容会自动回到 published，但这不是一个正经的复审队列）。

---

## 对既有行为的影响

- `GET /api/session` 多一个字段 `forumEnabled`（讨论区开关状态，默认 true）。
- `POST /api/reports` 的 `detail` 上限维持 2000（此前迁移里被误收到 1000，现在与接口一致）。
- 讨论区关闭时，`/api/forum/**`、`/api/admin/forum/**`、`/api/me/forum-posts` 全部返回 404。

---

## 合入顺序

`feat/packs` → `feat/forum`（本 PR）。收藏重构（PR B）依赖本 PR 的帖子表，需在其后合入。
