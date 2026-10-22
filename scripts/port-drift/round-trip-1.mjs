import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readSanitizedTextExtensions, sanitizeFixture } from './context.mjs';

export function registerRoundTripPart1() {
  it('preserves public guard negative port witnesses while still scrubbing identity', () => {
    const witness =
      "const api = process.env.API_SERVER_PORT ?? '3004'; const web = 'http://localhost:3003'; const owner = 'You';";
    for (const path of ['scripts/public-brand-validation.mjs', 'scripts/public-brand-validation.test.mjs']) {
      const output = sanitizeFixture(path, witness);
      assert.match(output, /\?\? '3002'/);
      assert.match(output, /http:\/\/localhost:3003/);
      assert.match(output, /owner = 'You'/);
    }
    const nested = sanitizeFixture('packages/scripts/public-brand-validation.mjs', witness);
    assert.match(nested, /\?\? '3004'/);
    assert.match(nested, /http:\/\/localhost:3003/);
  });

  it('sanitizes stored markup snapshots with the same text policy as their rendered inputs', () => {
    assert.ok(readSanitizedTextExtensions().includes('snap'));
    const output = sanitizeFixture(
      'packages/web/src/components/__tests__/__snapshots__/owner.test.tsx.snap',
      '<span>You</span><span>Clowder AI</span>',
    );
    assert.equal(output, '<span>You</span><span>Clowder AI</span>');
  });

  it('keeps repository references and encoded workspace paths consistent with transformed URLs', () => {
    const output = sanitizeFixture(
      'packages/web/src/components/__tests__/artifact.test.ts',
      [
        "ref: 'zts212653/clowder-ai#2247'",
        "url: 'https://github.com/zts212653/clowder-ai/pull/2247'",
        "sibling: 'zts212653/cat-cafe-tutorials#1'",
        "file: 'docs/BACKLOG.md'",
        "query: 'path=docs%2FBACKLOG.md'",
      ].join('\n'),
    );
    assert.match(output, /ref: 'zts212653\/clowder-ai#2247'/);
    assert.match(output, /url: 'https:\/\/github.com\/zts212653\/clowder-ai\/pull\/2247'/);
    assert.match(output, /sibling: 'zts212653\/cat-cafe-tutorials#1'/);
    assert.match(output, /file: 'docs\/ROADMAP.md'/);
    assert.match(output, /query: 'path=docs%2FROADMAP.md'/);
  });
}
