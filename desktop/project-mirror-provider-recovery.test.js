const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { fixture } = require('./project-mirror-materialization-fixture');
const { MARKER, entryState, inventory } = require('./project-mirror-resource-state');
const { waitForProjectMirrors } = require('./project-mirror-readiness');
const { prepareProjectMirrors } = require('./project-mirrors');

test('one interrupted resource recovery also replaces the old provider mirror before plugin writes', async (t) => {
  const value = fixture(t);
  const provider = path.join(value.installRoot, '.claude');
  fs.mkdirSync(provider);
  fs.writeFileSync(path.join(provider, 'settings.json'), '{"shipped":true}\n');
  for (const mirror of ['.claude', 'docs', 'cat-cafe-skills']) {
    fs.symlinkSync(
      path.join(value.installRoot, mirror),
      path.join(value.projectDir, mirror),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const source = path.join(value.installRoot, 'docs');
  const before = entryState(path.join(value.projectDir, 'docs'), source, 'docs');
  const { digest, records } = inventory(source, {});
  const id = randomUUID();
  const marker = { schemaVersion: 1, mirror: 'docs', digest, records, transactionId: id };
  const stage = path.join(value.projectDir, `.clowder-resource-${id}.stage`);
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify(marker));
  const journal = path.join(value.projectDir, '.clowder-resource-transaction.json');
  fs.writeFileSync(journal, JSON.stringify({ schemaVersion: 1, id, mirror: 'docs', source, before, marker }));

  prepareProjectMirrors(value);
  const ownedProvider = path.join(value.projectDir, '.claude');
  assert.equal(fs.lstatSync(ownedProvider).isSymbolicLink(), true, 'preparation defers until journal recovery');
  await waitForProjectMirrors(value);
  assert.equal(fs.existsSync(journal), false);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.lstatSync(ownedProvider).isSymbolicLink(), false, 'provider initialization must resume');
  const pluginSkill = path.join(ownedProvider, 'skills', 'fixture');
  fs.mkdirSync(pluginSkill, { recursive: true });
  fs.writeFileSync(path.join(pluginSkill, 'SKILL.md'), 'owner plugin skill\n');
  assert.equal(fs.existsSync(path.join(provider, 'skills')), false, 'plugin writes must not reach the installation');
  assert.equal(fs.readFileSync(path.join(provider, 'settings.json'), 'utf8'), '{"shipped":true}\n');
  assert.equal(fs.readFileSync(value.preserved, 'utf8'), 'protected roles and bindings\n');
});
