const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { prepareProjectMirrors } = require('./project-mirrors');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-install-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'installed');
  const projectDir = path.join(root, 'instance', 'project');
  fs.mkdirSync(path.join(installRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, '.claude', 'settings.json'), '{"shipped":true}\n');
  return { installRoot, projectDir };
}

test('the packaged file allowlist includes the provider initialization runtime closure', (t) => {
  const f = fixture(t);
  const packaged = path.join(f.installRoot, 'desktop-code');
  fs.mkdirSync(packaged);
  for (const file of require('./package.json').build.files) {
    if (!file.endsWith('.js') || file.includes('*')) continue;
    const target = path.join(packaged, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, file), target);
  }
  const { prepareProjectMirrors: packagedPrepare } = require(path.join(packaged, 'project-mirrors.js'));
  packagedPrepare(f);
  assert.equal(fs.lstatSync(path.join(f.projectDir, '.claude')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(f.projectDir, '.claude', 'settings.json'), 'utf8'), '{"shipped":true}\n');
});

test('source provider initialization preserves skill links without traversing missing or external targets', (t) => {
  const f = fixture(t);
  const skills = path.join(f.installRoot, '.claude', 'skills');
  fs.mkdirSync(skills);
  const external = path.join(f.installRoot, '..', 'external-owner');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'SKILL.md'), 'external owner data');
  const links = {
    'collective-participation': path.join('..', '..', 'cat-cafe-skills', 'collective-participation'),
    external: path.relative(skills, external),
  };
  for (const [name, target] of Object.entries(links)) {
    fs.symlinkSync(target, path.join(skills, name), 'dir');
  }
  prepareProjectMirrors(f);
  const owned = path.join(f.projectDir, '.claude');
  assert.equal(fs.lstatSync(owned).isSymbolicLink(), false);
  for (const [name, target] of Object.entries(links)) {
    assert.equal(fs.readlinkSync(path.join(owned, 'skills', name)), target);
    assert.equal(fs.readlinkSync(path.join(skills, name)), target);
  }
  assert.equal(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8'), 'external owner data');
  prepareProjectMirrors(f);
  assert.equal(
    fs.readlinkSync(path.join(owned, 'skills', 'collective-participation')),
    links['collective-participation'],
  );
});

test('an existing installation mirror becomes a writable owner directory without changing its target', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.projectDir, { recursive: true });
  const source = path.join(f.installRoot, '.claude');
  const destination = path.join(f.projectDir, '.claude');
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  prepareProjectMirrors(f);
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  fs.writeFileSync(path.join(destination, 'settings.json'), '{"owner":true}\n');
  assert.equal(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'), '{"shipped":true}\n');
  prepareProjectMirrors(f);
  assert.equal(fs.readFileSync(path.join(destination, 'settings.json'), 'utf8'), '{"owner":true}\n');
});

test('a custom owner provider link is preserved and blocks automatic replacement', (t) => {
  const f = fixture(t);
  const external = path.join(f.projectDir, '..', 'owner-provider');
  fs.mkdirSync(external, { recursive: true });
  fs.mkdirSync(f.projectDir, { recursive: true });
  fs.writeFileSync(path.join(external, 'settings.json'), '{"owner":true}\n');
  const destination = path.join(f.projectDir, '.claude');
  fs.symlinkSync(external, destination, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareProjectMirrors(f), /Preserving.*provider.*link/);
  assert.equal(fs.realpathSync(destination), fs.realpathSync(external));
  assert.equal(fs.readFileSync(path.join(external, 'settings.json'), 'utf8'), '{"owner":true}\n');
});

test('a failed provider publication restores the verified link and leaves its target unchanged', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.projectDir, { recursive: true });
  const source = path.join(f.installRoot, '.claude');
  const destination = path.join(f.projectDir, '.claude');
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === destination) throw new Error('controlled provider publication failure');
    return rename(from, to);
  });
  assert.throws(() => prepareProjectMirrors(f), /controlled provider publication failure/);
  assert.equal(fs.realpathSync(destination), fs.realpathSync(source));
  assert.equal(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'), '{"shipped":true}\n');
  assert.deepEqual(fs.readdirSync(f.projectDir), ['.claude']);
});

test('a relocated installation provider mirror migrates using its existing packages peer', (t) => {
  const f = fixture(t);
  const previous = path.join(f.installRoot, '..', 'previous-installation');
  fs.mkdirSync(path.join(previous, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(previous, 'packages'));
  fs.writeFileSync(path.join(previous, '.claude', 'settings.json'), '{"previous":true}\n');
  fs.mkdirSync(f.projectDir, { recursive: true });
  for (const name of ['.claude', 'packages']) {
    fs.symlinkSync(
      path.join(previous, name),
      path.join(f.projectDir, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  prepareProjectMirrors(f);
  assert.equal(fs.lstatSync(path.join(f.projectDir, '.claude')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(f.projectDir, '.claude', 'settings.json'), 'utf8'), '{"shipped":true}\n');
  assert.equal(fs.readFileSync(path.join(previous, '.claude', 'settings.json'), 'utf8'), '{"previous":true}\n');
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform} project-local plugin skill writes never enter the installation`, (t) => {
    const f = fixture(t);
    prepareProjectMirrors({ ...f, platform });
    const skill = path.join(f.projectDir, '.cat-cafe', 'plugin-host', 'fixture', 'skills', 'fixture');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'fixture plugin skill');
    const mounts = path.join(f.projectDir, '.claude', 'skills');
    fs.mkdirSync(mounts, { recursive: true });
    const link = path.join(mounts, 'fixture');
    fs.symlinkSync(
      process.platform === 'win32' ? skill : path.relative(mounts, skill),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(
      fs.existsSync(path.join(f.installRoot, '.claude', 'skills')),
      false,
      'the writable provider mount followed a mirror into the signed installation',
    );
    assert.equal(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), 'fixture plugin skill');
    assert.equal(fs.readFileSync(path.join(f.projectDir, '.claude', 'settings.json'), 'utf8'), '{"shipped":true}\n');
    prepareProjectMirrors({ ...f, platform });
    assert.equal(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), 'fixture plugin skill');
  });

  test(`${platform} preserves an existing owner provider directory`, (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.projectDir, '.claude'), { recursive: true });
    const owned = path.join(f.projectDir, '.claude', 'settings.json');
    fs.writeFileSync(owned, '{"owner":true}\n');
    prepareProjectMirrors({ ...f, platform });
    assert.equal(fs.readFileSync(owned, 'utf8'), '{"owner":true}\n');
    assert.equal(fs.lstatSync(path.dirname(owned)).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(f.installRoot, '.claude', 'settings.json'), 'utf8'), '{"shipped":true}\n');
  });
}
