# 设计：AI 翻译插件简介

> 状态：**已确认方向、待实现**（2026-11-01 与主创确认）
> 方案选型：**A（异步预翻译、译文入库）打底 + E（人工校对兜质量）**
> 关联：`docs/项目规划/设计-精选专栏.md`（同为「先设计后实现」的同类文档）

## 1. 需求与边界

### 1.1 要解决的问题

站内大量插件简介是英文（来源是 GitHub 仓库描述或 `package.json` 的 `dsh.bundle` 清单描述），
中文用户第一眼读不懂；而且**中文关键词搜不到**这些插件（目录搜索用 `LIKE` 匹配简介原文）。

### 1.2 做法（已确认）

- 用 AI 把**插件简介**译成中文，**译文入库**；
- 译文**直接公开**，但必须标注「机器翻译」；管理员可校对并标「已校对」；
- **只翻简介**：插件名、topics、评测正文、整合包说明都不翻（评测是作者写的，机器翻译会改语气）；
- 源文变化时自动重翻，**新译文就绪前继续显示上一版**（不出现空窗）。

### 1.3 明确不做

- 不做多语言（先只 `zh-CN`；表结构留 `lang` 便于以后加）；
- 不做实时逐字翻译、不做浏览器端翻译脚本；
- 不翻译用户生成内容（评测/评论/整合包），也不翻译插件名；
- 不做「翻译后自动发布新简介到 GitHub」这类反向写回。

## 2. 关键决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | 译文**入库**，不是每次请求现翻 | 用户零等待；中文可被搜索命中；可缓存去重 |
| D2 | 只翻 `description` 一个字段 | 范围小、成本低、语气风险最低 |
| D3 | 机器译文**直接公开 + 标注** | 否则 300+ 条会被人工审核卡住上线 |
| D4 | 显示优先级：**人工纠错 > 已校对译文 > 机器译文 > 原文** | 复用现有 `plugin_field_overrides` 作为最高优先 |
| D5 | 源文指纹 = `sha256(原文 + 模型 + 提示词版本)` | 源文没变不重翻；换模型/改提示词才会重译 |
| D6 | 按 `(plugin, lang, source_hash)` 存多行 | 保留历史；「上一版译文」天然可查，不覆盖旧值 |
| D7 | 已是中文的跳过 | 语言检测（中文字符占比），不产生无意义调用 |
| D8 | 供应商走**OpenAI 兼容协议** | 一个适配器可接 OpenAI / DeepSeek / 通义 / 本地 vLLM/Ollama |
| D9 | 密钥只走环境变量，**不进数据库** | `site_settings` 在后台可见，不能放凭据 |
| D10 | 预算不确定 → 设计成**可配上限 + 超额暂停** | 默认保守（每月调用数上限），超额把任务标 `skipped` 而不是悄悄烧钱 |

## 3. 数据模型（迁移 0035）

### 3.1 `plugin_description_translations`

| 字段 | 类型 | 约束 / 说明 |
|---|---|---|
| `id` | TEXT PK | UUIDv7 |
| `plugin_id` | TEXT | → `plugins(id)` CASCADE |
| `lang` | TEXT | 目前固定 `zh-CN`，`CHECK (lang = 'zh-CN')`（以后放开时改 CHECK） |
| `source_hash` | TEXT | `length = 64`；`sha256(原文 + 模型 + 提示词版本)` |
| `source_text` | TEXT | 翻译时的原文快照（≤ 2000 字）；用于「看原文」与人工校对对照 |
| `text` | TEXT | 译文（≤ 2000 字） |
| `status` | TEXT | `translated` / `reviewed` / `failed`，默认 `translated` |
| `model` | TEXT | 供应商标识 + 模型名（如 `deepseek:deepseek-chat`） |
| `prompt_version` | TEXT | 提示词版本（改提示词 = 换版本，参与 source_hash） |
| `error_code` | TEXT NULL | `status = failed` 时必填（`timeout` / `rate_limited` / `provider_error` / `empty_output` / `not_configured`） |
| `reviewed_by` | TEXT NULL | → `users(id)`；`status = reviewed` 时必填 |
| `reviewed_at` | INTEGER NULL | 同上 |
| `created_at` / `updated_at` | INTEGER | ≥ 0 |

约束与索引：

- `UNIQUE(plugin_id, lang, source_hash)`：同一份源文只译一次（重复入队幂等）；
- `CHECK ((status = 'reviewed') = (reviewed_at IS NOT NULL))`、`CHECK ((status = 'failed') = (error_code IS NOT NULL))`；
- `IDX(plugin_id, lang, source_hash)`、`IDX(status, updated_at)`（校对队列按状态扫）。

### 3.2 为什么多行而不是一行覆盖

- **保留历史**：人工校对过的译文不能被后来的机器译文覆盖（`reviewed` 行永不自动改写）；
- **满足「上一版译文本就绪前继续显示」**：显示层按 `source_hash` 精确匹配优先，匹配不到再回退到「最近一条可用译文」；
- 代价是行数会随简介改动增长；300 个插件、一年改两次 ≈ 600 行，量级可忽略（后续可加清理策略）。

### 3.3 配置项（沿用 `site_settings`，新增 5 项）

| 键 | 默认 | 说明 |
|---|---|---|
| `translate.enabled` | `false` | 总开关（未配密钥时保持关闭） |
| `translate.model` | `deepseek-chat` | 模型名；供应商由环境变量决定 base_url |
| `translate.max_calls_per_run` | `20` | 单轮任务最多翻多少条（控制账单与上游限流） |
| `translate.monthly_call_budget` | `2000` | 每月调用上限（次数，不是金额：金额随供应商变） |
| `translate.timeout_seconds` | `20` | 单条请求超时 |

密钥与地址：`TRANSLATE_API_KEY`、`TRANSLATE_BASE_URL`（环境变量，**不进库**）。
两者缺一 → 任务以 `not_configured` 直接 `skipped`，页面显示原文。

## 4. 流程与状态机

```
收录成功 / 资料刷新（源文变化）/ 管理员批量补翻
        │
        ▼
  入队 plugin_translate 任务（同 plugin 去重）
        │
        ▼
  语言检测 ──已是中文──→ 记 skipped（不建行）
        │
        ▼
  预算检查 ──超额/未配置──→ 任务 skipped（页面原文）
        │
        ▼
  调供应商（超时/限流/失败 → status=failed + error_code）
        │
        ▼
  写译文行（status=translated，source_hash 记录）
        │
        ▼
  （可选）管理员校对 → status=reviewed + reviewed_by/at
```

## 5. 展示与搜索

### 5.1 显示优先级（一处实现，全站复用）

```
plugin_field_overrides.description   ← 人工纠错（现有机制，最高优先，原样展示）
  > translations(status=reviewed 且 source_hash=当前)
  > translations(status=translated 且 source_hash=当前)
  > translations(最近一条 reviewed，忽略 hash)   ← 「上一版译文」兜底
  > translations(最近一条 translated，忽略 hash)
  > plugins.description ?? repositories.description（原文）
```

### 5.2 界面

| 位置 | 变化 |
|---|---|
| 插件卡片 | 显示中文译文；紧随其后一枚 `机器翻译` / `已校对` 小标签（`title` 里给原文） |
| 插件详情页 | 同上；简介下方给「查看原文」折叠（展示 `source_text`） |
| 目录搜索 | 匹配条件改为 `COALESCE(译文, 插件简介, 仓库简介)`，中文关键词可命中 |
| 空态 | 无译文时照旧显示原文，**不显示「翻译中」占位**（避免整页抖动） |

### 5.3 搜索改动的影响

`LIKE '%kw%'` 本来就是全表扫（现有实现如此），把简介换成 `COALESCE(译文, 原文)` 不改变复杂度；
但会让「中文可搜」成为现实——这是本功能对用户价值最大的一块，测试要覆盖。

## 6. 任务与触发

| 触发点 | 行为 |
|---|---|
| 收录成功（`acceptPluginSubmission`） | 若源文非中文 → 入队 `plugin_translate` |
| 资料刷新（每日同步/手动刷新，源文变化） | 同上（按 `source_hash` 去重，不会重复翻） |
| 管理员「批量补翻」 | 扫描 `status` 缺失或 `source_hash` 过期的插件，分批入队 |
| 重试 | 失败条目按 30s / 120s / 480s 退避，最多 3 次；仍失败则保留原文不再自动重试（可在后台手动重跑） |

任务类型：`TaskTypes` 增 `plugin_translate`（worker 已有队列、重试、进度，直接复用）。

## 7. 提示词与质量

- 系统提示：`你是技术文档译者。只翻译，不增删内容，不解释，不添加营销语言；保留产品名、包名、命令、URL 原样。`
- 术语表（固定译法，随提示词下发）：

| 原文 | 译法 |
|---|---|
| plugin | 插件 |
| bundle | 打包产物 |
| tool / skill | 工具 / 技能 |
| MCP server | MCP 服务 |
| command palette | 命令面板 |

- 输出校验：`是空` / `> 原文 3 倍长` / `包含「翻译如下」等说明性前缀` → 判 `empty_output` 或重试一次；
- 译文长度上限 2000 字（与源文同一 CHECK）。

## 8. 人工校对（E）

后台页 `/admin/translations`：

- 列表：`status=translated`（待校对）、`failed`（待重跑）；可按插件名/状态筛选；
- 每条显示：原文 | 机器译文（可编辑）；操作「保存并标已校对」「重译」「恢复原文」；
- 保存即写 `status=reviewed` + `reviewed_by/at`；重译只对 `translated` 行生效，**不动 reviewed 行**；
- 审计：`translate.review`（admin 动作）、`translate.retranslate`（admin 动作）、批量翻译记 `plugin.translate.run`（系统动作）。

## 9. 成本与限额

| 项 | 估算 |
|---|---|
| 单条简介 | 约 100–200 字（≈ 80–150 token 含提示词） |
| 全量 300 条 | 约 4–5 万 token；按主流国内模型价格 ≈ 0.1–0.5 元 |
| 日常增量 | 每天新增 0–10 个插件，成本可忽略 |

真正的约束不是钱而是**上游限流**与**误译观感**，所以设计上限是「次数」而不是「金额」：
`translate.monthly_call_budget` 到顶后任务标 `skipped` 并在后台提醒，管理员可调高或等下月。

## 10. 合规与数据

- 外发内容是**公开的插件简介**（已确认允许发第三方），不含用户隐私、不含账号信息；
- 请求体只含：简介原文 + 固定提示词 + 术语表，不带插件 ID、作者、仓库地址等可关联信息；
- 供应商的数据留存策略由主创选型时确认（这也是为什么供应商走可配置的 OpenAI 兼容协议，便于换）；
- 界面必须标注「机器翻译」——这是对读者的诚实，也是对译文的免责；
- 若将来要「不允许外发」，只换 `TRANSLATE_BASE_URL` 指向本地模型即可，代码不变。

## 11. 实现分期

| 期 | 内容 |
|---|---|
| P1（可交付） | 迁移 0035 + 翻译服务（语言检测/指纹/调用/校验）+ `plugin_translate` 任务 + 收录与刷新触发 + 显示优先级 + 卡片与详情标签 + 搜索接译文 |
| P2 | `/admin/translations` 校对后台 + 批量补翻按钮 + 三项审计事件 |
| P3（可选） | 术语表外置可编辑、多语言、失败告警、翻译质量抽检报告 |

## 12. 验收清单

| # | 场景 | 期望 |
|---|---|---|
| T1 | 英文简介收录 | 入队一次任务；译文落库 `status=translated` |
| T2 | 源文未变再次刷新 | 不产生新任务（`source_hash` 命中） |
| T3 | 源文变化 | 新建一行；新译文就绪前页面仍显示旧译文 |
| T4 | 中文简介 | 跳过，不调用供应商 |
| T5 | 未配置密钥 | 任务 `skipped`，页面显示原文，不报错 |
| T6 | 供应商超时/限流 | `status=failed` + 对应 `error_code`；重试 3 次后停止 |
| T7 | 译文为空/异常长 | 判失败，不落库 |
| T8 | 人工校对 | `status=reviewed`；后续机器重译不覆盖 |
| T9 | 人工纠错优先 | `plugin_field_overrides` 存在时显示它，不显示译文 |
| T10 | 中文搜索 | 搜「记忆」能命中简介为英文的插件（命中译文） |
| T11 | 预算到顶 | 任务 `skipped`；后台有提示；不产生调用 |
| T12 | 页面标注 | 卡片/详情显示「机器翻译」或「已校对」标签 |
| T13 | 查看原文 | 详情页可展开看到 `source_text` |
| T14 | 幂等 | 同一插件重复入队只产生一行 |

## 13. 开放问题

| # | 问题 | 当前默认 |
|---|---|---|
| Q1 | 具体供应商与月度预算数字 | 待主创确认；先用 `max_calls_per_run=20`、`monthly_call_budget=2000` 保守值 |
| Q2 | 校对是否开放给「编辑角色」 | 不做，仅管理员（现有角色体系只有 user/admin） |
| Q3 | 是否需要翻译质量抽检报告 | P3 可选 |
| Q4 | 是否翻译 `topics` 展示 | 不做（多为英文标签，可作为 P3 议题） |
| Q5 | 旧译文清理策略 | 暂不清理（行数可忽略），P3 再议 |

## 14. 迁移与回滚

- 迁移号 **0035**（当前最新 0034），纯新增表 + 5 项设置键，不改既有表；
- 关闭 `translate.enabled` 即回到现状（页面显示原文），**不需要回滚迁移**；
- 译文行可整体删除（`DELETE FROM plugin_description_translations`）而不影响任何其它功能。
