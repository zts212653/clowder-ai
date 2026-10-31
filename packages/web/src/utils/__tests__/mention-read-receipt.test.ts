import { expect, it, vi } from 'vitest';
import { notifyHandledMentionRead } from '../mention-read-receipt';

it.each([
  [{ handledMentionCount: 2 }, 1],
  [{ handledMentionCount: 0 }, 0],
  [{ handledMentionCount: -1 }, 0],
  [{ handledMentionCount: 0.5 }, 0],
  [{ handledMentionCount: '2' }, 0],
  [{}, 0],
  [null, 0],
])('emits only one invalidation for a valid, nonempty mark-all receipt %j', (receipt, expected) => {
  const changed = vi.fn();
  window.addEventListener('cat-cafe:user-mention-updated', changed);
  try {
    notifyHandledMentionRead(receipt);
    expect(changed).toHaveBeenCalledTimes(expected);
  } finally {
    window.removeEventListener('cat-cafe:user-mention-updated', changed);
  }
});
