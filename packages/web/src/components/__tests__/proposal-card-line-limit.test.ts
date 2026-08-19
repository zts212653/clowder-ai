/** F128 ProposalCard regression suites stay split below the repository hard line cap. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProposalCard test module line cap', () => {
  it('keeps proposal-card.test.tsx within 350 lines', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/__tests__/proposal-card.test.tsx'), 'utf8');
    const lineCount = source.split('\n').length - Number(source.endsWith('\n'));
    expect(lineCount).toBeLessThanOrEqual(350);
  });
});
