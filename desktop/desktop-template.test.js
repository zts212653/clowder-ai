const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { initializeDesktopTemplate } = require('./desktop-template');

test('fresh desktop starts empty; upgrade retains existing template and catalog identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-template-'));
  const install = path.join(root, 'install'),
    project = path.join(root, 'project');
  fs.mkdirSync(install);
  fs.mkdirSync(project);
  const source = path.join(install, 'cat-template.json');
  const template = {
    version: 2,
    roleTemplates: [{ id: 'menu' }],
    clientDefaults: {},
    breeds: [{ id: 'stock' }],
    roster: { owner: { role: 'co-creator' }, stock: { role: 'developer' } },
  };
  fs.writeFileSync(source, JSON.stringify(template));
  try {
    const target = initializeDesktopTemplate(install, project);
    const created = JSON.parse(fs.readFileSync(target));
    assert.deepEqual(created.breeds, [], 'factory menu must not instantiate unconfigured runtime members');
    assert.deepEqual(created.roleTemplates, template.roleTemplates);
    assert.deepEqual(created.roster, { owner: template.roster.owner });
    const existing = JSON.stringify({ ...template, breeds: [{ id: 'existing-id' }] });
    fs.writeFileSync(target, existing);
    fs.utimesSync(target, 1, 1);
    fs.mkdirSync(path.join(project, '.cat-cafe'));
    const catalog = path.join(project, '.cat-cafe/cat-catalog.json');
    fs.writeFileSync(catalog, 'persistent catalog witness');
    initializeDesktopTemplate(install, project);
    assert.equal(fs.readFileSync(target, 'utf8'), existing);
    assert.equal(fs.readFileSync(catalog, 'utf8'), 'persistent catalog witness');
    const legacy = path.join(root, 'legacy');
    fs.mkdirSync(path.join(legacy, '.cat-cafe'), { recursive: true });
    fs.writeFileSync(path.join(legacy, '.cat-cafe/cat-catalog.json'), 'legacy catalog witness');
    const restored = initializeDesktopTemplate(install, legacy);
    assert.deepEqual(JSON.parse(fs.readFileSync(restored)), template, 'existing catalog is not a new empty instance');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
