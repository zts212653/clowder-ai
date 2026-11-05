/** Compatibility names; all file operations are implemented by the common client. */
export {
  type ContentFileInfo as ArtworkFileInfo,
  copyArtworkPixels,
  downloadContentFile as downloadArtworkFile,
} from './file-action-client';

import { contentFileInfo, fileActionUrl, runContentFileAction } from './file-action-client';
export const artworkFileActionUrl = (url: string, action: 'file-info' | 'reveal' | 'open') =>
  fileActionUrl({ kind: 'url', url }, action);
export const artworkFileInfo = (url: string) => contentFileInfo({ kind: 'url', url });
export const runArtworkFileAction = (url: string, action: 'reveal' | 'open') =>
  runContentFileAction({ kind: 'url', url }, action);
