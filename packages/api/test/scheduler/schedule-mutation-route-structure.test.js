import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ROUTE_SOURCES = [
  new URL('../../src/routes/schedule.ts', import.meta.url),
  new URL('../../src/routes/schedule-route-support.ts', import.meta.url),
  new URL('../../src/routes/schedule-mutation-routes.ts', import.meta.url),
];

describe('schedule mutation route structure', () => {
  it('keeps the route composition and extracted modules under the 350-line hard cap', () => {
    const [scheduleSource, supportSource, mutationSource] = ROUTE_SOURCES.map((source) => readFileSync(source, 'utf8'));

    assert.match(scheduleSource, /scheduleMutationRoutes/);
    assert.doesNotMatch(scheduleSource, /app\.post\('\/api\/schedule\/tasks'/);
    for (const [index, source] of [scheduleSource, supportSource, mutationSource].entries()) {
      const lineCount = source.trimEnd().split('\n').length;
      assert.ok(lineCount <= 350, `${ROUTE_SOURCES[index].pathname} has ${lineCount} lines`);
    }
  });
});
