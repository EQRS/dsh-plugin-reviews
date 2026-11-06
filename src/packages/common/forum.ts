/**
 * 讨论区的共享常量与类型。
 *
 * 放在 common 而不是 server/modules/forum：客户端组件（发帖表单、排序切换）
 * 也要用这些文案与枚举，从 `@/server/modules/forum` 导入会把数据库层
 * 一起打进浏览器包。
 */

/** 发帖策略。 */
export const POSTING_POLICIES = ['everyone', 'whitelist', 'admin_only'] as const;
export type PostingPolicy = (typeof POSTING_POLICIES)[number];

export const POSTING_POLICY_LABELS: Record<PostingPolicy, string> = {
  everyone: '所有人可发',
  whitelist: '仅白名单可发',
  admin_only: '仅管理员可发',
};

/** 分区状态。 */
export const BOARD_STATUSES = ['active', 'archived'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const BOARD_STATUS_LABELS: Record<BoardStatus, string> = {
  active: '正常',
  archived: '已归档（只能读）',
};

/** 分区内成员角色。只在所属分区内生效，不写进 users.role。 */
export const BOARD_MEMBER_ROLES = ['owner', 'moderator'] as const;
export type BoardMemberRole = (typeof BOARD_MEMBER_ROLES)[number];

export const BOARD_MEMBER_ROLE_LABELS: Record<BoardMemberRole, string> = {
  owner: '区长',
  moderator: '协管',
};

/** 帖子/回复的状态。删除是软删。 */
export const FORUM_CONTENT_STATUSES = ['published', 'deleted'] as const;
export type ForumContentStatus = (typeof FORUM_CONTENT_STATUSES)[number];

/** 分区申请状态。 */
export const BOARD_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type BoardApplicationStatus = (typeof BOARD_APPLICATION_STATUSES)[number];

export const BOARD_APPLICATION_STATUS_LABELS: Record<BoardApplicationStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
};

/** 帖子列表排序。默认按发布时间（使用者口径 D8）。 */
export const POST_SORT_OPTIONS = ['created', 'last_reply'] as const;
export type PostSortOption = (typeof POST_SORT_OPTIONS)[number];

export const POST_SORT_LABELS: Record<PostSortOption, string> = {
  created: '最新发布',
  last_reply: '最后回复',
};

export const FORUM_LIMITS = {
  /** 分区名与 slug */
  boardNameMax: 60,
  boardSlugMax: 60,
  boardDescriptionMax: 500,
  /** 分区申请理由 */
  applicationReasonMax: 1000,
  /** 帖子 */
  postTitleMax: 120,
  postBodyMax: 20000,
  /** 回复 */
  replyBodyMax: 10000,
  /** 列表每页 */
  listPageSize: 20,
  /**
   * 一条帖子 / 一条顶层回复最多带几张图。
   *
   * 浏览器端与开放接口共用一个上限：服务端必须在写入事务里再判一次，
   * 否则直接调接口的人可以挂任意多张（UI 只限住了点按钮的那条路）。
   */
  postAttachmentsMax: 9,
  /**
   * 每人草稿条数上限（PR-讨论区.md「已知取舍」第 3 条：不分页，100 条封顶）。
   *
   * 这个上限必须由**服务端**执行：UI 不做删旧草稿的提示，直接调接口的人
   * 可以无限堆，而草稿列表是一次全量读 + 逐条查附件的 N+1，堆到几千条就慢了。
   */
  draftMax: 100,
} as const;

/** slug 只允许小写字母、数字与连字符，进 URL 才安全。 */
export const BOARD_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeBoardSlug(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
