import type { TransferListItem } from 'node:worker_threads';
import type { RemoteMessage, RemoteValue } from './protocol.js';

/** Native transferable streams keep transport backpressure, errors and cancellation. */
export function valueTransfers(value: RemoteValue): TransferListItem[] {
  switch (value.kind) {
    case 'readable':
      return [value.stream];
    case 'array':
      return value.items.flatMap(valueTransfers);
    case 'object':
      return value.entries.flatMap(([, child]) => valueTransfers(child));
    case 'error':
    case 'return-error':
      return valueTransfers(value.fields);
    case 'iterator':
      return [...valueTransfers(value.next), ...valueTransfers(value.end)];
    default:
      return [];
  }
}

export function messageTransfers(message: RemoteMessage): TransferListItem[] {
  switch (message.kind) {
    case 'call':
      return valueTransfers(message.args);
    case 'result':
      return valueTransfers(message.value);
    case 'abort':
      return valueTransfers(message.reason);
    default:
      return [];
  }
}
