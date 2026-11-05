import { createReadStream, lstatSync, type ReadStream } from 'node:fs';
import type { PiSessionSlot } from './pi-session-store.js';

function parseEntry(line: string): Record<string, unknown> {
  const entry: unknown = JSON.parse(line);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid native entry');
  const value = entry as Record<string, unknown>;
  if (typeof value.type !== 'string' || !value.type) throw new Error('Missing native entry type');
  return value;
}

async function* nativeLines(input: ReadStream): AsyncGenerator<string> {
  // Pi splits only on LF. readline also accepts bare CR, hiding corruption from the real loader.
  let pending = '';
  for await (const chunk of input) {
    pending += chunk;
    let end = pending.indexOf('\n');
    while (end >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
      end = pending.indexOf('\n');
    }
  }
  if (pending) yield pending;
}

/** Run under the native writer lease, before Pi can skip malformed lines or migrate the file. */
export async function assertPiHistoryIntegrity(slot: PiSessionSlot): Promise<void> {
  if (!slot.file) return;
  const input = createReadStream(slot.file, { encoding: 'utf8' });
  try {
    const stat = lstatSync(slot.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular native history');
    let first = true;
    for await (const line of nativeLines(input)) {
      if (!line.trim()) continue;
      const value = parseEntry(line);
      if (first && (value.type !== 'session' || value.version !== 3 || value.id !== slot.id || value.cwd !== slot.cwd))
        throw new Error('Native history identity changed');
      first = false;
    }
    if (first) throw new Error('Empty native history');
  } catch {
    throw new Error('Pi 原生会话历史损坏或格式不支持；原文件已保留，不会自动新建会话。');
  } finally {
    input.destroy();
  }
}
