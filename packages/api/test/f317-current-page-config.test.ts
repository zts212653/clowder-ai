import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfiguredPageAction } from '../src/domains/concierge/action/jev/page-action-config.js';

test('owner-selected page composition needs no prewritten page URL, target selector or readback', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f317-current-page-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'page.json');
  await writeFile(
    config,
    JSON.stringify({
      mode: 'owner-selected',
      profileId: 'owner-browser',
      browserURL: 'http://127.0.0.1:5272/',
      allowJevProjection: true,
    }),
  );
  const result = await readConfiguredPageAction({
    CAT_CAFE_JEV_PAGE_CONFIG: config,
    TYPESAFE_API_KEY: 'isolated-test',
  });
  assert.ok(result && 'currentPages' in result);
  assert.equal('profile' in result, false, 'no page is granted before the owner chooses it');
});
