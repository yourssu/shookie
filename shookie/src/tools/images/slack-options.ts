import { createSlackAttachmentOptions, type AttachmentSlackClient } from '../attachments/slack-authorization.js';
import { AttachmentError } from '../attachments/policy.js';
import type { DownloadDependencies } from '../attachments/download.js';
import { imageMime } from './policy.js';
import type { ImageToolOptions } from './tools.js';
import type { VisionConfig, VisionDependencies } from './transport.js';

/** Reuses the full live authorization bridge. MIME selection is trusted server code, not input. */
export function createSlackImageOptions(client: AttachmentSlackClient, botToken: string, vision: VisionConfig,
  downloadDependencies?: DownloadDependencies, visionDependencies?: VisionDependencies): ImageToolOptions {
  return { ...createSlackAttachmentOptions(client, botToken, downloadDependencies, mime => {
    try { return imageMime(mime); } catch { throw new AttachmentError('UNSUPPORTED_TYPE'); }
  }), vision, visionDependencies };
}
