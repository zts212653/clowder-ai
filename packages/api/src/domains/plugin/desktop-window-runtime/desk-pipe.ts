import { z } from 'zod';
import { type DesktopDeskOwner, deskOwnerCommand } from '../../concierge/live/host/companion-desk-owner.js';

const frame = z
  .object({ v: z.literal(1), type: z.literal('desk'), id: z.string().uuid(), command: deskOwnerCommand })
  .strict();

/** F335 交付三：dedicated trusted kernel pipe for the desk delivery (same shape as the app-assist pipe). */
export function createDeskPipe(owner: DesktopDeskOwner | undefined, write: (line: string) => void) {
  const pending = new Set<string>();
  let closed = false;
  return {
    accept(input: unknown): boolean {
      const parsed = frame.safeParse(input);
      if (!parsed.success) return false;
      const value = parsed.data;
      if (!owner || closed || pending.has(value.id)) throw new Error('Invalid desk pipe');
      if (pending.size >= 4) {
        write(`${JSON.stringify({ v: 1, type: 'desk', id: value.id, reply: 'unavailable' })}\n`);
        return true;
      }
      pending.add(value.id);
      void owner
        .request(value.command)
        .catch(() => 'unavailable' as const)
        .then((reply) => {
          pending.delete(value.id);
          if (!closed) write(`${JSON.stringify({ v: 1, type: 'desk', id: value.id, reply })}\n`);
        });
      return true;
    },
    close() {
      closed = true;
      pending.clear();
    },
  };
}
