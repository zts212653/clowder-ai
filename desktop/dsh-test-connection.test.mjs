import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

for (const alias of ['home', 'config'])
  test(`snapshot refuses canonical ${alias} escape without changing the source`, async () => {
    const { snapshotDshTestConnection } = await import('./scripts/snapshot-dsh-test-connection.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alias-'));
    try {
      const source = path.join(root, 'source'),
        target = path.join(root, 'target'),
        cache = path.join(root, 'cache');
      fs.mkdirSync(path.join(source, '.dsh/profiles/acp'), { recursive: true });
      fs.mkdirSync(path.join(cache, '_npx'), { recursive: true });
      fs.writeFileSync(path.join(source, '.dsh/profiles/acp/package.json'), '{}');
      if (alias === 'home') fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      else {
        fs.mkdirSync(target);
        fs.symlinkSync(
          path.join(source, '.dsh'),
          path.join(target, '.dsh'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      assert.throws(
        () => snapshotDshTestConnection({ sourceHome: source, targetHome: target, npmCache: cache }),
        /separate|boundary/i,
      );
      assert.equal(fs.existsSync(path.join(source, 'AppData')), false);
      assert.equal(fs.readFileSync(path.join(source, '.dsh/profiles/acp/package.json'), 'utf8'), '{}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('isolated DSH snapshot retains ACP connection and live installed cache without copying history or replacing config', async () => {
  const { snapshotDshTestConnection } = await import('./scripts/snapshot-dsh-test-connection.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-connection-'));
  try {
    const source = path.join(root, 'source'),
      target = path.join(root, 'isolated');
    const write = (rel, value) => {
      const file = path.join(source, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    };
    write('.dsh/profiles/acp/package.json', '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-acp-app"]}}}');
    write('.dsh/profiles/acp/cordis.yml', 'test-only connection');
    write('.dsh/.credentials.yaml', 'fixture-provider: fixture-only-value');
    write('.dsh/llm-deepseek/files-v3.json', '{"records":["private-file-history"]}');
    write('.dsh/sessions/user-history', 'never copy');
    fs.mkdirSync(path.join(source, 'AppData/Local/npm-cache/_npx'), { recursive: true });
    snapshotDshTestConnection({
      sourceHome: source,
      targetHome: target,
      npmCache: path.join(source, 'AppData/Local/npm-cache'),
    });
    assert.equal(fs.existsSync(path.join(target, '.dsh/.credentials.yaml')), false);
    snapshotDshTestConnection({
      sourceHome: source,
      targetHome: target,
      npmCache: path.join(source, 'AppData/Local/npm-cache'),
      includeCredentials: true,
    });
    assert.equal(fs.readFileSync(path.join(target, '.dsh/profiles/acp/cordis.yml'), 'utf8'), 'test-only connection');
    assert.equal(
      fs.readFileSync(path.join(target, '.dsh/.credentials.yaml'), 'utf8'),
      'fixture-provider: fixture-only-value',
    );
    assert.equal(fs.existsSync(path.join(target, '.dsh/llm-deepseek/files-v3.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.dsh/sessions')), false);
    write(
      'AppData/Local/npm-cache/_npx/new-install/node_modules/@deepseek-ai/dsh/package.json',
      '{"name":"@deepseek-ai/dsh"}',
    );
    assert.equal(
      fs.existsSync(
        path.join(target, 'AppData/Local/npm-cache/_npx/new-install/node_modules/@deepseek-ai/dsh/package.json'),
      ),
      true,
    );
    fs.writeFileSync(path.join(target, '.dsh/profiles/acp/cordis.yml'), 'user-edited');
    fs.writeFileSync(path.join(target, '.dsh/.credentials.yaml'), 'user-edited-credential');
    snapshotDshTestConnection({
      sourceHome: source,
      targetHome: target,
      npmCache: path.join(source, 'AppData/Local/npm-cache'),
      includeCredentials: true,
    });
    assert.equal(fs.readFileSync(path.join(target, '.dsh/profiles/acp/cordis.yml'), 'utf8'), 'user-edited');
    assert.equal(fs.readFileSync(path.join(target, '.dsh/.credentials.yaml'), 'utf8'), 'user-edited-credential');
    assert.equal(fs.readFileSync(path.join(source, '.dsh/profiles/acp/cordis.yml'), 'utf8'), 'test-only connection');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
