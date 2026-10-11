# 环境坑：Node v24.12.0 上 `fs.cpSync` 遇 CJK 路径硬崩

**发现者**：`gf-platform`（在写反恒真自检脚本时踩到）。
**独立复核**：主控，脚本 `scripts/verify-node-cpsync.mjs`，2026-10-11。

## 现象

> `fs.cpSync(src, dest, { recursive: true })` 当 **`src` 是目录** 且 **`src` 路径含非 ASCII（CJK）字符** 时，
> Node v24.12.0 进程以 **`0xC0000409`（STATUS_STACK_BUFFER_OVERRUN，退出码 -1073740791）** 立即终止。
> 无 JS 异常、无 stderr 输出、**不可 try/catch 捕获**。

## 实测矩阵（本机复现）

| 用例 | 结果 |
|---|---|
| `src` 目录含 CJK + `recursive: true` | **硬崩 0xC0000409** |
| `src` 目录全 ASCII + `recursive: true`（控制组） | OK |
| `src` 目录含 CJK + `recursive: false` | 不崩，正常抛 `ERR_FS_EISDIR` |
| `src` 是**文件**（含 CJK 文件名） | OK（必须是目录） |
| 仅 **dest** 含 CJK | OK（问题在 **src** 侧） |
| `await fs.promises.cp(...)` 同样输入 | **OK** |

结论：**`cpSync`（同步版）+ 目录 + src 含 CJK** 三条同时满足才崩；异步 `fs.promises.cp` 不受影响。

## 对本项目的影响

工作区路径本身含 CJK（`D:\developing\ds民间科研成果展示\插件测评网站`），因此：

- **产品代码不受影响** —— 项目代码不做任何目录递归复制。
- **脚本/测试/构建步骤有风险** —— 任何在项目内用 `cpSync` 复制目录的脚本都会硬崩。
  - 已有的 `scripts/verify-tests-bite.mjs` 用的是 `copyFileSync`（单文件），不受影响。
  - 日后新增脚本请改用 **`fs.promises.cp`**，或逐文件 `readFileSync`/`writeFileSync`。

## 为什么值得单独记一笔

这类崩溃**不是 JS 异常**，`try/catch` 抓不到，日志也不会有输出 —— 表现为"进程突然消失了，什么都没打印"，
极易被误判成"任务被杀"或"内存不足"，从而浪费大量排查时间。写下结论是为了下次少走一遍。
