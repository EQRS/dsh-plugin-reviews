/**
 * 内容类型契约（浏览器可用）。
 *
 * 本文件不导入任何 server 代码；页面与接口共用这些形状。
 * 与 已删除的设计稿《模块签名契约》 保持一致。
 */

import type {
  AccountStatus,
  ModerationResult,
  RepositoryAvailabilityState,
  ReviewSourceKind,
  SubmissionState,
  UserRole,
  VersionValue,
} from './field-rules';

export interface ViewerSummary {
  userId: string;
  nickname: string;
  role: UserRole;
  accountStatus: AccountStatus;
  githubProfileVisible: boolean;
}

export interface PluginSummary {
  pluginId: string;
  repositoryId: string;
  /** 展示名称（缺少来源资料时回退为 仓库名 + 子路径）。 */
  name: string;
  ownerName: string;
  repositoryFullName: string;
  pluginPath: string;
  htmlUrl: string;
  description: string | null;
  availabilityState: RepositoryAvailabilityState;
  isArchived: boolean;
  updatedAt: string;
}

export interface PluginView extends PluginSummary {
  /** 收录状态说明：核验vs实测分别标注，不把收录当成"已测试可用"。 */
  listingNote: string;
}

export interface DraftPayloadView {
  title: string;
  body_markdown: string;
  plugin_version: VersionValue;
  dsh_version: VersionValue;
}

export interface DraftView {
  draftId: string;
  reviewId: string;
  ownerId: string;
  payloadSchemaVersion: number;
  saveVersion: number;
  savedAt: string;
  payload: DraftPayloadView;
}

export interface ReviewSummary {
  reviewId: string;
  pluginId: string;
  pluginName: string;
  title: string;
  sourceKind: ReviewSourceKind;
  pluginVersion: VersionValue;
  dshVersion: VersionValue;
  authorNickname: string;
  publishedAt: string | null;
  publicUpdatedAt: string | null;
}

export interface ReviewDetail extends ReviewSummary {
  bodyMarkdown: string;
  revisionId: string;
  revisionNumber: number;
  /** 内容当前是否公开；与"某次提交已通过"分别表达（架构第 56 节）。 */
  publiclyVisible: boolean;
  withdrawnAt: string | null;
  hiddenAt: string | null;
}

export interface CommentView {
  commentId: string;
  contentEntityId: string;
  authorId: string;
  authorNickname: string;
  body: string;
  isReply: boolean;
  replyToCommentId: string | null;
  rootCommentId: string | null;
  publishedAt: string | null;
  editedAt: string | null;
  /** 删除/隐藏后的占位（架构第 79.3 节）。 */
  placeholder: 'deleted' | 'hidden' | null;
}

export interface SubmissionStatusView {
  submissionId: string;
  processingState: SubmissionState;
  stateVersion: number;
  snapshotRef: { kind: 'review_revision' | 'comment_revision'; id: string };
  lastProcessedAt: string | null;
  /** 允许公开的失败/退回原因。 */
  reasons: { result: ModerationResult; reason: string }[];
  availableActions: ('retry' | 'appeal' | 'edit')[];
}
