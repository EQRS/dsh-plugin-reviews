/**
 * 用户身份体系 · 前台状态与展示判定（设计 `docs/项目规划/设计-用户身份体系.md` §5.1 / §6）。
 *
 * 这个文件**不碰数据库**，只做两件事：
 *   1. `buildRolePanel`：把服务层给的原始事实（持有的身份 / 待审申请 / 最近一次驳回 / 资格计数）
 *      整理成页面直接能渲染的 `RolePanelView`；
 *   2. `decideRoleAction`：给定「资格状态 + 当前身份 + 冷却期」判定这一个身份槽该显示哪种形态。
 *
 * 为什么要拆成纯函数：页面弹层有四条互斥分支（已持有 / 审核中 / 冷却中 / 可申请），
 * 这四条分支的优先级最容易写反 —— 把判定抽出来，测试才能逐条钉住「同时满足多种条件时谁优先」，
 * 而不必起一个浏览器去点。
 *
 * 展示口吻遵循设计 §5.1：**条件未满足时按钮置灰并写明缺什么**，不给一个点了才知道失败的入口。
 */

export type RoleType = 'reviewer' | 'developer';

/** 面板里的固定顺序：与设计 §5.1 的示例一致（先测评员、后开发者）。 */
export const ROLE_TYPES: readonly RoleType[] = ['reviewer', 'developer'];

export const ROLE_LABELS: Record<RoleType, string> = {
  reviewer: '测评员',
  developer: '开发者',
};

/** 门槛的人话（与设计 §4.1 / §4.2 逐字对应）。 */
export const ROLE_CONDITIONS: Record<RoleType, string> = {
  reviewer: '至少一篇**已发布**的测评（草稿、待审、被驳回的都不算）',
  developer: '至少一个**已验证归属**的插件（GitHub 账号与仓库 owner 相同的会自动通过）',
};

/** 一个用户可以同时持有多个身份（设计 §3.1），界面上按固定顺序列出。 */
export interface HeldRole {
  roleType: RoleType;
  grantedAt: number;
}

/** 待审申请（一个身份同时只可能有一条，库里有部分唯一索引兜底）。 */
export interface PendingApplication {
  id: string;
  roleType: RoleType;
  createdAt: number;
  note: string | null;
}

/** 最近一次被驳回的申请：冷却期从驳回时刻起算。 */
export interface RejectedApplication {
  id: string;
  roleType: RoleType;
  reviewedAt: number;
  reviewNote: string | null;
}

/** 资格事实：门槛的「当前进度」与「阈值」。 */
export interface RoleEligibility {
  /** 已发布的测评篇数 / 已验证归属的插件个数。 */
  count: number;
  /** 阈值：当前口径都是 1（「至少一篇 / 至少一个」）。 */
  required: number;
}

export interface RolePanelInput {
  roles: readonly HeldRole[];
  pending: readonly PendingApplication[];
  rejected: readonly RejectedApplication[];
  eligibility: Record<RoleType, RoleEligibility>;
  /** 冷却期天数（设置项 `roles.application_cooldown_days`）。 */
  cooldownDays: number;
  /** 判定「现在」的时刻；缺省取 `Date.now()`。显式传入让测试不受时钟影响。 */
  now?: number;
}

/** 冷却期的毫秒数。非正数表示「没有冷却」（管理员把天数调到 0）。 */
export function cooldownMs(cooldownDays: number): number {
  const days = Number.isFinite(cooldownDays) && cooldownDays > 0 ? Math.floor(cooldownDays) : 0;
  return days * 24 * 60 * 60 * 1000;
}

/** 剩余冷却天数：向上取整（差 1 毫秒也说「还剩 1 天」，不能说「还剩 0 天」却不让点）。 */
export function remainingCooldownDays(reviewedAt: number, cooldownDays: number, now: number): number {
  const end = reviewedAt + cooldownMs(cooldownDays);
  if (end <= now) return 0;
  return Math.ceil((end - now) / (24 * 60 * 60 * 1000));
}

/**
 * 一个身份槽的展示形态。四条互斥分支 + 一个「站点关闭」态。
 *
 * 优先级（**顺序即语义**，测试逐条钉住）：
 *   已持有 > 审核中 > 冷却中 > 可申请。
 * 理由：
 *   * 「已是测评员」不该同时出现「申请」按钮 —— 先判持有；
 *   * 待审时不允许再提交（库里也有部分唯一索引兜底），所以审核中压过资格判定；
 *   * 冷却期只在**没有待审申请**时才成为理由（撤回后无冷却，设计 §3.2 状态机）。
 */
export type RoleActionState = 'held' | 'pending' | 'cooldown' | 'eligible' | 'ineligible';

export interface RoleActionDecision {
  type: RoleType;
  state: RoleActionState;
  /** 按钮文案；无按钮时为空串（**不是** disabled 按钮，免得上了一条走不通的路）。 */
  buttonLabel: string;
  disabled: boolean;
  /** 「当前进度」一行的人话，例如「已有 3 篇」「还差一篇已发布的测评」。 */
  progressText: string;
  /** 状态说明（审核中 / 驳回理由 + 剩余天数 / 已是该身份）。 */
  statusText: string;
  /** 已持有或审核中时，这一条右侧是否给「撤回申请」。 */
  canWithdraw: boolean;
  /** 待撤回的申请 id（canWithdraw 为真时非空）。 */
  pendingApplicationId: string | null;
  /** 驳回理由（冷却中才有）。 */
  rejectionNote: string | null;
  /** 剩余冷却天数（冷却中才大于 0）。 */
  remainingDays: number;
  /** 门槛是否「现在」就满足（冷却中仍可能是 true —— 缺的是冷却不是资格）。 */
  qualified: boolean;
}

function findHeld(input: RolePanelInput, type: RoleType): HeldRole | undefined {
  return input.roles.find((r) => r.roleType === type);
}

function findPending(input: RolePanelInput, type: RoleType): PendingApplication | undefined {
  return input.pending.find((p) => p.roleType === type);
}

/** 同类型可能被驳回多次，只有**最近一次**驳回的冷却期有意义。 */
function findRejected(input: RolePanelInput, type: RoleType): RejectedApplication | undefined {
  const hits = input.rejected.filter((r) => r.roleType === type);
  if (hits.length === 0) return undefined;
  return hits.reduce((a, b) => (b.reviewedAt > a.reviewedAt ? b : a));
}

/** 把计数说成人话：进度与缺口都用它，避免两处口径不一致。 */
function progressTextFor(type: RoleType, eligibility: RoleEligibility): { qualified: boolean; text: string } {
  const count = Math.max(0, Math.floor(Number.isFinite(eligibility.count) ? eligibility.count : 0));
  const required = Math.max(1, Math.floor(Number.isFinite(eligibility.required) ? eligibility.required : 1));
  if (count >= required) {
    return { qualified: true, text: type === 'reviewer' ? `已有 ${count} 篇已发布的测评` : `已有 ${count} 个已验证归属的插件` };
  }
  if (type === 'reviewer') {
    return { qualified: false, text: '还差一篇已发布的测评' };
  }
  return { qualified: false, text: '还差一个已验证归属的插件' };
}

/** 判定一个身份槽该显示哪种形态。纯函数：同样的输入永远同样的输出（`now` 显式传入）。 */
export function decideRoleAction(input: RolePanelInput, type: RoleType): RoleActionDecision {
  const now = input.now ?? Date.now();
  const { qualified, text: progressText } = progressTextFor(type, input.eligibility[type]);
  const label = ROLE_LABELS[type];
  const base: RoleActionDecision = {
    type,
    state: 'ineligible',
    buttonLabel: '申请',
    disabled: true,
    progressText,
    statusText: '',
    canWithdraw: false,
    pendingApplicationId: null,
    rejectionNote: null,
    remainingDays: 0,
    qualified,
  };

  // 1) 已持有：不给按钮，直接说明「已是 X」。
  const held = findHeld(input, type);
  if (held) {
    return {
      ...base,
      state: 'held',
      buttonLabel: '',
      disabled: true,
      statusText: `已是${label}，无需申请`,
    };
  }

  // 2) 审核中：可以撤回，但不能再提交（库里同一身份只允许一条待审）。
  const pending = findPending(input, type);
  if (pending) {
    return {
      ...base,
      state: 'pending',
      buttonLabel: '',
      disabled: true,
      statusText: '审核中',
      canWithdraw: true,
      pendingApplicationId: pending.id,
    };
  }

  // 3) 冷却中：被驳回后的冷静期，按钮置灰并写明理由与剩余天数。
  const rejected = findRejected(input, type);
  if (rejected) {
    const remaining = remainingCooldownDays(rejected.reviewedAt, input.cooldownDays, now);
    if (remaining > 0) {
      const reason = (rejected.reviewNote ?? '').trim();
      return {
        ...base,
        state: 'cooldown',
        disabled: true,
        statusText:
          `上次申请被驳回${reason.length > 0 ? `：${reason}` : ''}（${remaining} 天后可再次申请）`,
        rejectionNote: reason.length > 0 ? reason : null,
        remainingDays: remaining,
      };
    }
  }

  // 4) 资格判定：满足才给可点的「申请」。
  if (!qualified) {
    return {
      ...base,
      state: 'ineligible',
      disabled: true,
      // 开发者缺的是「自己的插件」，把它引到「我的插件」去认领；测评员缺的是内容，只能去写。
      buttonLabel: type === 'developer' ? '去认领插件' : '去写测评',
      statusText: '',
    };
  }

  return { ...base, state: 'eligible', buttonLabel: '申请', disabled: false };
}

export interface RolePanelView {
  actions: RoleActionDecision[];
  /** 顶部一行「当前持有」的汇总：没有附加身份时是空数组。 */
  heldLabels: string[];
  /** 冷门但有用：冷却中的身份有几条，供面板标题旁提示。 */
  coolingDownCount: number;
}

/** 一次性算出面板要渲染的全部内容（服务端组件在这里调一次即可）。 */
export function buildRolePanel(input: RolePanelInput): RolePanelView {
  const actions = ROLE_TYPES.map((type) => decideRoleAction(input, type));
  const heldLabels = ROLE_TYPES.filter((type) => input.roles.some((r) => r.roleType === type)).map(
    (type) => ROLE_LABELS[type],
  );
  return {
    actions,
    heldLabels,
    coolingDownCount: actions.filter((a) => a.state === 'cooldown').length,
  };
}

/** 「附加身份」一行的显示文本：没有任何附加身份时给出可操作的提示。 */
export function heldRolesText(labels: readonly string[]): string {
  return labels.length > 0 ? labels.join('、') : '暂无（可在下方申请）';
}
