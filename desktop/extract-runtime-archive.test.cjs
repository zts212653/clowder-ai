const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { extractRuntimeArchive } = require('./scripts/extract-runtime-archive.cjs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const npmCli = path.join(
  path.dirname(process.execPath),
  process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js',
);
const tar = createRequire(npmCli)('tar');

test(
  'native dangerous archive rejection reports its real failure through the child process',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dangerous-native-'));
    try {
      fs.mkdirSync(path.join(root, 'input'));
      fs.writeFileSync(path.join(root, 'input/Clowder AI.exe'), 'never write');
      fs.mkdirSync(path.join(root, 'bundled/archives'), { recursive: true });
      const file = path.join(root, 'bundled/archives/electron.tar.gz');
      await tar.c({ file, cwd: path.join(root, 'input'), prefix: '..', gzip: true }, ['Clowder AI.exe']);
      let entries = 0;
      await tar.t({ file, onReadEntry: () => entries++ });
      fs.writeFileSync(
        file + '.json',
        JSON.stringify({
          archive: 'electron.tar.gz',
          entries,
          bytes: fs.statSync(file).size,
          sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        }),
      );
      const code = `const {createRequire}=require('node:module'); const tar=createRequire(${JSON.stringify(npmCli)})('tar'); require(${JSON.stringify(require.resolve('./scripts/extract-runtime-archive.cjs'))}).extractRuntimeArchive(${JSON.stringify(root)},'electron.tar.gz',tar,{engine:'native',onProgress:e=>console.log(JSON.stringify(e))}).catch(e=>{console.error(e.message);process.exitCode=1;});`;
      const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', windowsHide: true });
      const events = child.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(child.status, 1);
      assert.equal(events.at(-1).status, 'failed');
      assert.equal(events.at(-1).runId, events[0].runId);
      assert.match(events.at(-1).message, /escapes runtime directory/);
      assert.doesNotMatch(child.stderr, /dest.destroy/);
      assert.equal(fs.existsSync(path.join(root, 'Clowder AI.exe')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('keeps Unicode runtime files and fails on missing/unknown payloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-extraction-'));
  try {
    const input = path.join(root, 'input');
    fs.mkdirSync(path.join(input, '中文目录'), { recursive: true });
    fs.writeFileSync(path.join(input, '中文目录/snow ☃.txt'), 'unicode witness');
    fs.writeFileSync(path.join(input, 'Clowder AI.exe'), 'entry witness');
    fs.mkdirSync(path.join(root, 'bundled/archives'), { recursive: true });
    await tar.c({ file: path.join(root, 'bundled/archives/electron.tar.gz'), gzip: true, cwd: input }, ['.']);
    const events = [];
    await extractRuntimeArchive(root, 'electron.tar.gz', tar, {
      allowLegacy: true,
      onProgress: (event) => events.push(event),
    });
    assert.equal(events[0]?.status, 'start');
    assert.equal(events.at(-1)?.status, 'complete');
    assert.ok(events.at(-1).entries >= 3);
    assert.equal(fs.readFileSync(path.join(root, 'desktop-dist/中文目录/snow ☃.txt'), 'utf8'), 'unicode witness');
    await assert.rejects(extractRuntimeArchive(root, 'unknown.tar.gz', tar), /Unknown/);
    await assert.rejects(extractRuntimeArchive(root, 'deploy-api.tar.gz', tar), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer extracts bundled Node first and stops on any extraction error', () => {
  const script = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
  assert.ok(
    script.indexOf("AfterInstall: ExtractRuntimeArchive('node.tar.gz')") <
      script.indexOf("AfterInstall: ExtractRuntimeArchive('deploy-api.tar.gz')"),
  );
  assert.match(script, /ExitCode <> 0[\s\S]*FailRuntimeExtraction/);
  assert.match(script, /extract-runtime-archive\.cjs/);
});

test('an existing entry cannot make a newly incomplete upgrade archive succeed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-upgrade-'));
  try {
    const input = path.join(root, 'input');
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'NOTICE.txt'), 'new payload');
    fs.mkdirSync(path.join(root, 'desktop-dist'));
    const entry = path.join(root, 'desktop-dist/Clowder AI.exe');
    fs.writeFileSync(entry, 'existing installation');
    fs.mkdirSync(path.join(root, 'bundled/archives'), { recursive: true });
    await tar.c({ file: path.join(root, 'bundled/archives/electron.tar.gz'), gzip: true, cwd: input }, ['.']);
    await assert.rejects(
      extractRuntimeArchive(root, 'electron.tar.gz', tar, { allowLegacy: true }),
      /Incomplete runtime archive/,
    );
    assert.equal(fs.readFileSync(entry, 'utf8'), 'existing installation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'native Windows extraction verifies before writing and preserves Unicode with real progress',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-extraction-'));
    try {
      const input = path.join(root, 'input');
      const destination = path.join(root, 'desktop-dist');
      fs.mkdirSync(input, { recursive: true });
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(input, 'Clowder AI.exe'), 'new entry');
      fs.writeFileSync(path.join(destination, 'Clowder AI.exe'), 'old entry');
      fs.mkdirSync(path.join(root, 'bundled/archives'), { recursive: true });
      const file = path.join(root, 'bundled/archives/electron.tar.gz');
      await tar.c({ file, gzip: true, cwd: input }, ['.']);
      let entries = 0;
      await tar.t({ file, onReadEntry: () => entries++ });
      const manifest = { archive: 'electron.tar.gz', entries, bytes: fs.statSync(file).size, sha256: '0'.repeat(64) };
      fs.writeFileSync(file + '.json', JSON.stringify(manifest));
      await assert.rejects(
        extractRuntimeArchive(root, manifest.archive, tar, { engine: 'native' }),
        /integrity mismatch/,
      );
      assert.equal(fs.readFileSync(path.join(destination, 'Clowder AI.exe'), 'utf8'), 'old entry');
      manifest.sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      fs.writeFileSync(file + '.json', JSON.stringify(manifest));
      const events = [];
      await extractRuntimeArchive(root, manifest.archive, tar, { engine: 'native', onProgress: (e) => events.push(e) });
      assert.equal(events.at(-1).engine, 'native');
      assert.equal(events.at(-1).entries, entries);
      assert.ok(events.at(-1).verifyMs >= 0);
      assert.ok(events.at(-1).extractMs >= 0);
      assert.ok(events.at(-1).verifyMs + events.at(-1).extractMs <= events.at(-1).elapsedMs);
      fs.mkdirSync(path.join(input, '中文目录'), { recursive: true });
      fs.writeFileSync(path.join(input, '中文目录/snow ☃.txt'), 'unicode witness');
      await tar.c({ file, gzip: true, cwd: input }, ['.']);
      entries = 0;
      await tar.t({ file, onReadEntry: () => entries++ });
      Object.assign(manifest, {
        entries,
        bytes: fs.statSync(file).size,
        sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      });
      fs.writeFileSync(file + '.json', JSON.stringify(manifest));
      await extractRuntimeArchive(root, manifest.archive, tar, { engine: 'native', onProgress: (e) => events.push(e) });
      assert.equal(events.at(-1).engine, 'node-unicode');
      assert.equal(fs.readFileSync(path.join(destination, '中文目录/snow ☃.txt'), 'utf8'), 'unicode witness');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
