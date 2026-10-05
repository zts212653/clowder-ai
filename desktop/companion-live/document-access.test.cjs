const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, rmSync, existsSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const { DocumentAccess } = require('./document-access.cjs');

test('only explicit native confirmation grants access; grant and revocation survive relaunch', async () => {
  const storage = mkdtempSync(resolve(tmpdir(), 'f317-document-access-'));
  try {
    const access = new DocumentAccess({ storage, sourceRoot: '/fixture' });
    assert.equal(access.allowed(), false);
    await access.confirm(async () => ({ response: 1 }));
    assert.equal(access.allowed(), false);
    await access.confirm(async () => ({ response: 0 }));
    assert.equal(access.allowed(), true);
    assert.equal(new DocumentAccess({ storage, sourceRoot: '/fixture' }).allowed(), true);
    const household = new DocumentAccess({ storage, sourceRoot: '/fixture', hostOrigin: 'http://localhost:3383' });
    assert.equal(household.allowed(), false, 'a feature-only grant cannot silently expand to household memory');
    assert.equal(new DocumentAccess({ storage, sourceRoot: '/different-source' }).allowed(), false);
    await access.confirm(async () => ({ response: 1 }));
    assert.equal(new DocumentAccess({ storage, sourceRoot: '/fixture' }).allowed(), false);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test('Host household tools default on without a second grant; explicit pause survives relaunch', async () => {
  const storage = mkdtempSync(resolve(tmpdir(), 'f317-host-access-'));
  const options = { storage, sourceRoot: '/fixture', hostOrigin: 'http://localhost:3383' };
  try {
    const access = new DocumentAccess(options);
    assert.equal(access.allowed(), true);
    assert.equal(
      existsSync(resolve(storage, 'document-access.json')),
      false,
      'default policy does not fabricate a grant',
    );
    let dialog;
    await access.confirm(async (value) => {
      dialog = value;
      return { response: 1 };
    });
    assert.ok(dialog.buttons.includes('暂停资料查询'));
    assert.equal(new DocumentAccess(options).allowed(), false);
    await access.confirm(async () => ({ response: 0 }));
    assert.equal(new DocumentAccess(options).allowed(), true);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test('invalid or mismatched persisted choices never turn into default Host access', () => {
  const storage = mkdtempSync(resolve(tmpdir(), 'f317-host-access-invalid-'));
  try {
    const access = new DocumentAccess({ storage, sourceRoot: '/fixture', hostOrigin: 'http://localhost:3383' });
    writeFileSync(access.path, '{broken');
    assert.equal(access.allowed(), false);
    writeFileSync(access.path, JSON.stringify({ scope: 'different', recipient: 'codex-chatgpt-astra', allowed: true }));
    assert.equal(access.allowed(), false);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});
