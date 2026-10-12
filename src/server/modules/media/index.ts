/**
 * media 模块公共出口（架构第 67.2 节）。
 */

export {
  createMediaService,
  mediaService,
  resetMediaService,
  probeImage,
  buildDisplayImage,
  storageKeyFor,
  mediaUrl,
  MEDIA_LIMITS,
} from './service';

export type {
  MediaService,
  MediaServiceDeps,
  AttachmentView,
  MediaErrorCode,
  AllowedMime,
} from './service';
