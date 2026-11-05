import { z } from 'zod';
import {
  appAssistOwnerCommand,
  type DesktopAppAssistOwner,
} from '../../concierge/live/host/companion-app-assist-owner.js';

const frame = z
  .object({ v: z.literal(1), type: z.literal('app_assist'), id: z.string().uuid(), command: appAssistOwnerCommand })
  .strict();

/** Dedicated trusted kernel pipe. Never routed through renderer command validation. */
export function createAppAssistPipe(owner: DesktopAppAssistOwner | undefined, write: (line: string) => void) {
  const pending = new Set<string>();
  let closed = false;
  return {
    accept(input: unknown): boolean {
      const parsed = frame.safeParse(input);
      if (!parsed.success) return false;
      const value = parsed.data;
      if (!owner || closed || pending.has(value.id)) throw new Error('Invalid app-assist pipe');
      // Native deadlines can retire their caller before its Host work drains.
      // A new valid id needs backpressure, not termination of the private pipe.
      if (pending.size >= 4) {
        write(`${JSON.stringify({ v: 1, type: 'app_assist', id: value.id, reply: 'unavailable' })}\n`);
        return true;
      }
      pending.add(value.id);
      void owner
        .request(value.command)
        .catch(() => 'unavailable')
        .then((reply) => {
          pending.delete(value.id);
          if (!closed) write(`${JSON.stringify({ v: 1, type: 'app_assist', id: value.id, reply })}\n`);
        });
      return true;
    },
    close() {
      closed = true;
      pending.clear();
    },
  };
}
