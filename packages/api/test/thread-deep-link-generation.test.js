import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const sourceFiles = ['../src/index.ts', '../src/routes/messages.ts', '../src/routes/callbacks.ts'];

describe('thread deep-link generation', () => {
  for (const sourceFile of sourceFiles) {
    it(`${sourceFile} does not emit /threads/ frontend deep links`, () => {
      const source = readFileSync(new URL(sourceFile, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /deepLinkUrl:[\s\S]{0,160}\/threads\//);
    });
  }
});
