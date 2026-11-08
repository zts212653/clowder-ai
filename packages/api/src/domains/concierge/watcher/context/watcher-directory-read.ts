import { createHash } from 'node:crypto';
import type { createWatcherNativeBridge } from '@cat-cafe/mcp-server/dist/watcher-native-bridge.js';
import { saveWatcherState } from '../watcher-checkpoint.js';
import type { WatcherInvocationOwners, WatcherRunState } from '../watcher-invocation-contract.js';
import { boundedWatcherResult } from './watcher-context-budget.js';

type Bridge = Awaited<ReturnType<typeof createWatcherNativeBridge>>;
type Result = Awaited<ReturnType<Bridge['call']>>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Directory metadata keeps every entry/cursor. Original descriptions remain in the durable receipt;
 * the model reads their actual page through read_memory_matter instead of repeatedly copying summaries. */
export function compactWatcherDirectory(result: Result): Result {
  return {
    ...result,
    content: (Array.isArray(result.content) ? result.content : []).map((block: unknown) => {
      if (
        !block ||
        typeof block !== 'object' ||
        !('type' in block) ||
        block.type !== 'text' ||
        !('text' in block) ||
        typeof block.text !== 'string'
      )
        return block;
      let value: unknown;
      try {
        value = JSON.parse(block.text);
      } catch {
        return block;
      }
      if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return block;
      const items = value.items.map((item: unknown) => {
        if (!item || typeof item !== 'object') return item;
        const { description: _description, ...metadata } = item as Record<string, unknown>;
        return metadata;
      });
      return { type: 'text' as const, text: JSON.stringify({ ...value, items }) };
    }),
  } as Result;
}

/** The invocation's original Session CAS owns these read receipts across native retries/restarts. */
export function watcherDirectoryReader(owners: WatcherInvocationOwners, run: WatcherRunState, bridge: Bridge) {
  let tail: Promise<unknown> = Promise.resolve();
  const delivered = new Set<string>();
  const reuse = (entry: NonNullable<WatcherRunState['state']['directoryReads']>[number]): Result => {
    const page = JSON.parse(entry.page) as Result;
    const again = delivered.has(entry.hash);
    delivered.add(entry.hash);
    return again
      ? {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                alreadyRead: true,
                originalCallId: entry.callId,
                next: '本轮已取得同一目录；需要原话请读取目录中的事情页。',
              }),
            },
          ],
          _meta: { watcherDirectoryReused: entry.callId },
        }
      : { ...page, _meta: { watcherDirectoryReused: entry.callId } };
  };
  return (args: unknown, callId: string, signal: AbortSignal): Promise<Result> => {
    const read = async (): Promise<Result> => {
      signal.throwIfAborted();
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return bridge.call('cat_cafe_list_memory_matters', args, callId, signal);
      // The canonical directory schema has flat query/cursor/limit fields, without nested filters.
      const key = hash(JSON.stringify(args, Object.keys(args as object).sort()));
      const prior = run.state.directoryReads?.find((entry) => entry.key === key);
      if (prior) {
        const id = run.state.attempt!.invocationId;
        const auth = await owners.registry.peekRecord(id);
        if (
          !auth ||
          !(await owners.registry.verify(id, auth.callbackToken)).ok ||
          auth.userId !== run.session.userId ||
          auth.threadId !== run.session.threadId ||
          auth.catId !== run.session.catId ||
          auth.toolExecutionPolicy?.mode !== 'watcher' ||
          !auth.toolExecutionPolicy.allowedToolNames.includes('cat_cafe_list_memory_matters')
        )
          throw new Error('Watcher invocation no longer active');
        if ((await owners.registry.consumeWatcherToolCall(id, callId, 'cat_cafe_list_memory_matters')) !== 'accepted')
          throw new Error('watcher_tool_budget_exhausted');
        return reuse(prior);
      }
      const result = await bridge.call('cat_cafe_list_memory_matters', args, callId, signal);
      if (result.isError) return result;
      const projected = compactWatcherDirectory(result);
      const fingerprint = hash(JSON.stringify(projected.content));
      const same = run.state.directoryReads?.find((entry) => entry.hash === fingerprint);
      const serialized = JSON.stringify(projected);
      const page =
        serialized.length <= 12000
          ? serialized
          : JSON.stringify({ content: [{ type: 'text', text: boundedWatcherResult(projected, callId) }] });
      run.state = await saveWatcherState(owners.sessions, run.session.id, run.state, {
        directoryReads: [...(run.state.directoryReads ?? []), { key, hash: fingerprint, callId, page }].slice(-6),
      });
      if (same) return reuse(same);
      delivered.add(fingerprint);
      return result;
    };
    const result = tail.then(read);
    tail = result.catch(() => undefined);
    return result;
  };
}
