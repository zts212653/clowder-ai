import { createHash } from 'node:crypto';

import type { CloudReturnGrantScope } from './cloud-return-grant.js';

export function buildCloudReturnMessageIdempotencyKey(input: CloudReturnGrantScope): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: 1, ...input }))
    .digest('hex');
  return `f247-cloud-return:${digest}`;
}
