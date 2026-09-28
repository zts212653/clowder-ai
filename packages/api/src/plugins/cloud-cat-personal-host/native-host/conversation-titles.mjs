import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';

const MAX_BYTES = 64 * 1024;
const MAX_TITLES = 32;
const fields = new Set(['conversationId', 'authorizedAt', 'displayTitle', 'observedAt']);
export const conversationTitlesPath = (authorizationPath) => `${authorizationPath}.titles.json`;
const isoTime = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function safeConversationTitle(value) {
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value))
    return undefined;
  const title = value.trim().replace(/\s+/g, ' ');
  return title && !/^(ChatGPT|New chat|新聊天)$/iu.test(title) ? title : undefined;
}

function validTitle(record) {
  return (
    record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    Object.keys(record).every((field) => fields.has(field)) &&
    typeof record.conversationId === 'string' &&
    /^[A-Za-z0-9-]{1,200}$/u.test(record.conversationId) &&
    isoTime(record.authorizedAt) &&
    isoTime(record.observedAt) &&
    record.observedAt >= record.authorizedAt &&
    safeConversationTitle(record.displayTitle) === record.displayTitle
  );
}

/** Display metadata is optional. Corruption must never invalidate authorization. */
export async function readConversationTitles(authorizationPath) {
  let handle;
  try {
    handle = await open(conversationTitlesPath(authorizationPath), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES || (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600))
      return [];
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return [];
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (
      value?.v !== 1 ||
      !Array.isArray(value.titles) ||
      value.titles.length > MAX_TITLES ||
      !value.titles.every(validTitle)
    )
      return [];
    if (new Set(value.titles.map(({ conversationId }) => conversationId)).size !== value.titles.length) return [];
    return value.titles;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

export function projectConversationTitles(conversations, titles) {
  return conversations.map((conversation) => {
    const title = titles.find(
      (candidate) =>
        candidate.conversationId === conversation.conversationId &&
        candidate.authorizedAt === conversation.authorizedAt,
    );
    return {
      ...conversation,
      ...(title ? { displayTitle: title.displayTitle, titleObservedAt: title.observedAt } : {}),
    };
  });
}

/** Call under the authorization mutation lease, so revoke cannot race this write. */
export async function writeConversationTitles(authorizationPath, conversations, updates = []) {
  const previous = await readConversationTitles(authorizationPath);
  const titles = conversations.flatMap((conversation) => {
    const matches = (candidate) =>
      candidate.conversationId === conversation.conversationId && candidate.authorizedAt === conversation.authorizedAt;
    const update = updates.find(matches);
    const existing = previous.find(matches);
    const next =
      update && validTitle(update) && (!existing || update.observedAt >= existing.observedAt) ? update : existing;
    return next ? [next] : [];
  });
  if (titles.length > MAX_TITLES) throw new Error('conversation title limit exceeded');
  const destination = conversationTitlesPath(authorizationPath);
  if (!titles.length) {
    await unlink(destination).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return;
  }
  const payload = `${JSON.stringify({ v: 1, titles })}\n`;
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error('conversation title size limit exceeded');
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, destination);
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
