/**
 * 整合包安装命令适配器（`idea.md` §26；`架构设计.md` §36.2）。
 *
 * 唯一职责：把**结构化的安装目标**翻译成 DSH 安装命令，并且明确区分「可确认」与「待核实」。
 *
 * 为什么不在数据库里存命令文本：
 *   * 命令是目标的**派生结果**，存两份事实迟早不一致（改了目标忘了改命令）；
 *   * 命令格式由 DSH/pnpm 决定（`dsh plugin --profile <name> <args...>` 把参数转发给 pnpm），
 *     只要改这里就能全线生效，不必刷数据；
 *   * 「待核实」必须是**没有命令**，而不是一条猜出来的命令 —— 猜错会让用户装错版本。
 *
 * 已查证的口径（`idea.md` §26 第 416 行）：npm 来源支持 `包名@明确版本` 并可加 `--save-exact`；
 * GitHub 来源用 `github:owner/repo#<完整提交SHA>` 固定提交。`<profile>` 是占位符，
 * 由用户换成自己的 DSH profile 名。
 */

import type { VersionValue } from './field-rules';

/** 结构化安装目标。两种来源覆盖 P0；其它来源一律视为「待核实」。 */
export type InstallTarget =
  | { kind: 'npm'; packageName: string; version: string }
  | { kind: 'github'; repository: string; commit: string; pluginPath: string };

export const INSTALL_PROFILE_PLACEHOLDER = '<profile>';

/** npm 包名（含 scope）：小写字母/数字/._-，可带 @scope/。 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** 版本号只做"非空、无空白"校验：不强行 semver，上游可能写日期或 tag。 */
const NPM_VERSION = /^[^\s/]{1,64}$/;
/** GitHub 仓库 owner/name。 */
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
/** 提交：短 SHA 至少 7 位；完整 SHA 40 位。 */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export function isNpmPackageName(value: string): boolean {
  return NPM_NAME.test(value);
}

export function isGithubRepository(value: string): boolean {
  return GITHUB_REPO.test(value);
}

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA.test(value);
}

/** 把 JSON 里的原始值规范化成 `InstallTarget`；不合法返回 null（= 待核实），不抛错。 */
export function normalizeInstallTarget(raw: unknown): InstallTarget | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.kind === 'npm') {
    const packageName = typeof obj.packageName === 'string' ? obj.packageName.trim() : '';
    const version = typeof obj.version === 'string' ? obj.version.trim() : '';
    if (!isNpmPackageName(packageName) || !NPM_VERSION.test(version)) return null;
    return { kind: 'npm', packageName, version };
  }

  if (obj.kind === 'github') {
    const repository = typeof obj.repository === 'string' ? obj.repository.trim() : '';
    const commit = typeof obj.commit === 'string' ? obj.commit.trim().toLowerCase() : '';
    const pluginPath = typeof obj.pluginPath === 'string' && obj.pluginPath.trim().length > 0 ? obj.pluginPath.trim() : '.';
    if (!isGithubRepository(repository) || !isCommitSha(commit)) return null;
    return { kind: 'github', repository, commit, pluginPath };
  }

  return null;
}

/** 目标 → 一条可复制命令。调用方必须先用 `normalizeInstallTarget` 确认它合法。 */
export function buildInstallCommand(target: InstallTarget): string {
  if (target.kind === 'npm') {
    return `dsh plugin --profile ${INSTALL_PROFILE_PLACEHOLDER} add ${target.packageName}@${target.version} --save-exact`;
  }
  // GitHub 来源不需要再带子目录：DSH 从仓库根读取清单，多插件仓库用子目录定位的情况
  // 由目标里的 pluginPath 记录（供展示与人工核对），命令本身固定提交即可。
  return `dsh plugin --profile ${INSTALL_PROFILE_PLACEHOLDER} add github:${target.repository}#${target.commit} --save-exact`;
}

export interface CommandInputItem {
  pluginId: string;
  displayName: string;
  pluginVersion: VersionValue;
  installTarget: InstallTarget | null;
  /** 未生成命令时的来源入口（`idea.md` §26：仍可展示来源链接）。 */
  sourceUrl?: string | null;
}

export interface CommandOutputItem extends CommandInputItem {
  /** null = 待核实（**不要**编命令）。 */
  command: string | null;
  /** 待核实的原因，直接展示给用户。 */
  pendingReason: string | null;
}

export interface CommandBundle {
  items: CommandOutputItem[];
  /** 可复制命令文本（只含已确认项，按清单顺序，换行分隔）。 */
  copyAll: string;
  /** 待核实条数（批量复制前要提示，§26）。 */
  pendingCount: number;
}

/** 批量生成：逐条 + 全部复制共用同一份解析结果。 */
export function buildInstallCommands(items: readonly CommandInputItem[]): CommandBundle {
  const output: CommandOutputItem[] = items.map((item) => {
    if (item.installTarget === null) {
      return { ...item, command: null, pendingReason: '安装目标待核实（作者未提供可确认的包名/版本或提交）' };
    }
    if (item.installTarget.kind === 'npm' && item.pluginVersion.kind !== 'known') {
      return { ...item, command: null, pendingReason: '插件版本未知，不能生成带版本的安装命令' };
    }
    return { ...item, command: buildInstallCommand(item.installTarget), pendingReason: null };
  });

  const commands = output.filter((i) => i.command !== null).map((i) => i.command as string);
  return {
    items: output,
    copyAll: commands.join('\n'),
    pendingCount: output.length - commands.length,
  };
}

/** 供 UI 展示的目标摘要（不执行任何网络请求）。 */
export function describeInstallTarget(target: InstallTarget): string {
  if (target.kind === 'npm') return `npm：${target.packageName}@${target.version}`;
  const path = target.pluginPath && target.pluginPath !== '.' ? ` · 子目录 ${target.pluginPath}` : '';
  return `GitHub：${target.repository}#${target.commit.slice(0, 7)}${path}`;
}
