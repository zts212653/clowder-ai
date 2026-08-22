const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const CHAT_ROUTE_PAGES = [
  path.resolve(__dirname, '../src/app/(chat)/page.tsx'),
  path.resolve(__dirname, '../src/app/(chat)/thread/[threadId]/page.tsx'),
];

describe('chat route document cache policy', () => {
  it('renders chat entry documents dynamically so a new build cannot reuse an old HTML shell', () => {
    for (const pagePath of CHAT_ROUTE_PAGES) {
      const source = fs.readFileSync(pagePath, 'utf8');
      assert.match(
        source,
        /export const dynamic = ['"]force-dynamic['"];/,
        `${path.relative(process.cwd(), pagePath)} must opt out of static HTML caching`,
      );
    }
  });
});
