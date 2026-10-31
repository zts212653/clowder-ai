import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCatCatalogRaw } from '../dist/config/cat-catalog-store.js';

test('preflight projects legacy bindings without persisting catalog migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'account-readonly-'));
  try {
    mkdirSync(join(root, '.cat-cafe'));
    const path = join(root, '.cat-cafe/cat-catalog.json');
    const raw = JSON.stringify({
      version: 1,
      breeds: [
        {
          id: 'fixture',
          catId: 'fixture-cat',
          variants: [{ id: 'fixture-default', provider: 'anthropic', providerProfileId: 'claude' }],
        },
      ],
    });
    writeFileSync(path, raw);
    const result = readCatCatalogRaw(root, { persistMigrations: false });
    assert.equal(readFileSync(path, 'utf8'), raw, 'the preflight must not migrate the production catalog');
    const projected = JSON.parse(result).breeds[0].variants[0];
    assert.equal(projected.clientId, 'anthropic');
    assert.equal(projected.accountRef, 'claude');
    assert.equal(projected.providerProfileId, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
