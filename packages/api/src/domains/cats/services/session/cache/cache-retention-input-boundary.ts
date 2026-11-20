import type { TurnExecutionCacheFacts } from '../../stores/ports/TurnExecutionCacheFacts.js';
import type { RetentionWindow } from './cache-retention-state.js';

/** A maintenance receipt never rebases the normal source's input boundary. */
export async function retentionInputRefusal(
  window: RetentionWindow,
  facts?: TurnExecutionCacheFacts,
): Promise<'input_order_unproven' | 'real_input_started' | undefined> {
  const frozen = window.sourceInputSequence;
  if (!facts || !Number.isSafeInteger(frozen) || frozen === undefined || frozen < 1) return 'input_order_unproven';
  try {
    const [head, source] = await Promise.all([
      facts.head(window),
      facts.sequenceOf(window, window.source.invocationId),
    ]);
    if (source !== frozen || !Number.isSafeInteger(head) || head < frozen) return 'input_order_unproven';
    if (head > frozen) return 'real_input_started';
    if (window.receipts.some((receipt) => receipt.returnAfterSequence !== frozen)) return 'input_order_unproven';
    return undefined;
  } catch {
    return 'input_order_unproven';
  }
}
