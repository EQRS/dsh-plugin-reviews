/**
 * 命名空间与切片边界声明。
 *
 * 本切片（见 docs/README-切片说明.md / docs/最小切片-设计映射.md）只实现一条垂直薄片：
 *   登录 → 收录插件 → 写／审／发一篇评测 → 评论
 *
 * 为了让多个实现者可以并行、且写范围互不重叠，代码按前缀划分所有权：
 *   src/packages/common/**        —— 公共契约（错误、结果、字段规则、状态文案）
 *   src/server/platform/**        —— 基础设施（连接、事务、ID、时间、日志）
 *   migrations/**                 —— 权威表结构与受限触发器
 *   src/server/modules/<module>/** —— 各业务模块，只在自身目录内写入
 *   src/server/workflows/**       —— 跨模块协调流程（单一作者）
 *   src/server/adapters/**        —— 外部依赖适配器
 *   src/app/**                    —— 页面与 HTTP 接口边界
 *
 * 任何模块都不允许在其目录之外创建文件；跨模块协作通过本目录的契约
 * 与 src/server/workflows 完成。分组与写作范围见 docs/并行分组协议.md。
 */

export const SLICE_NAME = '登录 → 收录插件 → 写/审/发一篇评测 → 评论' as const;

export {};
