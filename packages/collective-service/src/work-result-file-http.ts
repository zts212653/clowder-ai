import type { IncomingMessage, ServerResponse } from 'node:http';
import { COLLECTIVE_WORK_RESULT_FILE_PATH, parseCollectiveWorkResultFilePath } from '@cat-cafe/shared';
import { CollectiveServiceError } from './errors.js';
import { requireBearer } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

export function routeWorkResultFileGet(
  store: CollectiveServiceStore,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (!url.pathname.startsWith(COLLECTIVE_WORK_RESULT_FILE_PATH)) return false;
  const address = parseCollectiveWorkResultFilePath(url.pathname);
  if (!address) throw new CollectiveServiceError('WORK_RESULT_FILE_NOT_FOUND', 'Work result file was not found', 404);
  const { record, bytes } = store.readWorkResultFile(requireBearer(request), address.fileId, address.fileName);
  response.setHeader('content-type', `${record.mediaType}; charset=utf-8`);
  response.setHeader('content-disposition', `inline; filename="${record.fileName}"`);
  response.setHeader('content-length', String(bytes.length));
  response.setHeader('etag', `"${record.contentDigest}"`);
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.writeHead(200).end(bytes);
  return true;
}
