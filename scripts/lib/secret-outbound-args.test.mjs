import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSecretSafeSend } from './secret-outbound-args.mjs';

const roots = [];
const snapshots = [];
function file(text) {
  const root = mkdtempSync(join(tmpdir(), 'send-fixture-'));
  roots.push(root);
  const path = join(root, 'note.txt');
  writeFileSync(path, text);
  return path;
}
const secret = () => ['ghp', '_', 'D'.repeat(36)].join('');
afterEach(() => {
  for (const snapshot of snapshots.splice(0)) snapshot.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('freeze and scan actual send content', () => {
  it('blocks explicit gh credential disclosure before running the delegate', async () => {
    for (const args of [
      ['auth', 'token'],
      ['auth', 'status', '--show-token'],
    ])
      await assert.rejects(prepareSecretSafeSend('gh', args), /credential_disclosure_blocked_before_read/);
  });
  for (const [program, args] of [
    ['gh', (path) => ['issue', 'comment', '1', '--body-file', path]],
    ['gh', (path) => ['api', 'repos/example/project/issues', '-F', `body=@${path}`]],
    ['gh', (path) => ['gist', 'create', path]],
    ['curl', (path) => ['--data-binary', `@${path}`, 'https://example.invalid']],
    ['curl', (path) => ['-F', `note=@${path}`, 'https://example.invalid']],
  ])
    it(`rejects ${program} ${args('file').join(' ')}`, async () => {
      await assert.rejects(prepareSecretSafeSend(program, args(file(secret()))), /secret_content_detected/);
    });

  it('sends the inspected bytes after the original body file changes', async () => {
    const path = file('clean body');
    const prepared = await prepareSecretSafeSend('gh', ['issue', 'comment', '1', '--body-file', path]);
    snapshots.push(prepared);
    writeFileSync(path, secret());
    const frozen = prepared.args.at(-1);
    assert.notEqual(frozen, path);
    assert.equal(readFileSync(frozen, 'utf8'), 'clean body');
    prepared.dispose();
    assert.ok(!existsSync(frozen));
  });

  it('consumes stdin once and rewrites it to the inspected snapshot', async () => {
    let reads = 0;
    const prepared = await prepareSecretSafeSend('curl', ['--data', '@-', 'https://example.invalid'], {
      readStdin: async () => {
        reads++;
        return Buffer.from('safe stdin');
      },
    });
    snapshots.push(prepared);
    assert.equal(reads, 1);
    const path = prepared.args[prepared.args.indexOf('--data') + 1].slice(1);
    assert.equal(readFileSync(path, 'utf8'), 'safe stdin');
  });

  it('rejects a token sent as GET query and never permits config-based invisible requests', async () => {
    await assert.rejects(
      prepareSecretSafeSend('curl', [`https://example.invalid/?q=${secret()}`]),
      /secret_content_detected/,
    );
    await assert.rejects(
      prepareSecretSafeSend('curl', ['--config', file('url = https://example.invalid')]),
      /secret_send_config_unsupported/,
    );
  });

  it('leaves clean gh reads unchanged and suppresses implicit curl config loading', async () => {
    const gh = await prepareSecretSafeSend('gh', ['pr', 'view', '1']);
    snapshots.push(gh);
    assert.deepEqual(gh.args, ['pr', 'view', '1']);
    const curl = await prepareSecretSafeSend('curl', ['-fsS', 'https://example.invalid/docs']);
    snapshots.push(curl);
    assert.deepEqual(curl.args, ['-q', '-f', '-s', '-S', 'https://example.invalid/docs']);
  });
  it('inspects larger attachments across chunk boundaries without changing their bytes', async () => {
    const body = 'safe attachment\n'.repeat(150000);
    const path = file(body);
    const prepared = await prepareSecretSafeSend('curl', ['--upload-file', path, 'https://example.invalid']);
    snapshots.push(prepared);
    assert.equal(readFileSync(prepared.args[2], 'utf8'), body);
    writeFileSync(path, 'A'.repeat(1024 * 1024 - 5) + secret() + 'B'.repeat(1024 * 1024));
    await assert.rejects(
      prepareSecretSafeSend('curl', ['-T', path, 'https://example.invalid']),
      /secret_content_detected/,
    );
  });

  it('checks curl payloads hidden behind combined short flags', async () => {
    await assert.rejects(
      prepareSecretSafeSend('curl', [`-sd@${file(secret())}`, 'https://example.invalid']),
      /secret_content_detected/,
    );
  });

  it('rejects abbreviated curl options and multipart secondary file references', async () => {
    await assert.rejects(
      prepareSecretSafeSend('curl', ['--data-bin', `@${file(secret())}`, 'https://example.invalid']),
      /secret_send_option_unsupported/,
    );
    await assert.rejects(
      prepareSecretSafeSend('curl', ['-F', `name=clean;headers=@${file(secret())}`, 'https://example.invalid']),
      /secret_send_form_unsupported/,
    );
  });

  it('freezes implicit gist stdin even when options are present', async () => {
    await assert.rejects(
      prepareSecretSafeSend('gh', ['gist', 'create', '--public', '--filename', 'note.md'], {
        readStdin: async () => Buffer.from(secret()),
      }),
      /secret_content_detected/,
    );
  });

  it('rejects gh implicit editors and content derived outside the supplied arguments', async () => {
    for (const args of [
      ['pr', 'create', '--fill'],
      ['issue', 'comment', '1', '--editor'],
      ['pr', 'create', '--template', file(secret())],
      ['gist', 'edit', 'gist-id', '--filename', 'remote-file.md'],
      ['pr', 'create', '--title', '--body'],
      ['gist', 'edit', 'gist-id', '--filename', '--desc'],
    ])
      await assert.rejects(prepareSecretSafeSend('gh', args), /secret_send_implicit_content_unsupported/);
  });

  for (const [label, args] of [
    ['release draft', (path) => ['release', 'create', 'v1', '-d', path]],
    ['release alias and clustered flags', (path) => ['release', 'new', 'v1', '-dp', path]],
    ['gist alias', (path) => ['gist', 'new', path]],
  ])
    it(`scans assets with command-specific option roles: ${label}`, async () => {
      await assert.rejects(prepareSecretSafeSend('gh', args(file(secret()))), /secret_content_detected/);
    });

  it('freezes explicit gist stdin alongside another asset', async () => {
    await assert.rejects(
      prepareSecretSafeSend('gh', ['gist', 'create', file('safe file'), '-'], {
        readStdin: async () => Buffer.from(secret()),
      }),
      /secret_content_detected/,
    );
  });

  it('keeps metadata option values separate from assets for each gh subcommand', async () => {
    const asset = file('safe asset');
    for (const args of [
      ['release', 'create', 'v1', '-d=false', '--target', 'main', '--discussion-category', 'General', asset],
      ['release', 'create', 'v1', '-dp', '--notes-start-tag', 'v0', '-n', 'release notes', asset],
      ['release', 'upload', 'v1', '--clobber', '--', asset],
      ['gist', 'create', '--desc', 'gist description', '-f', 'public-name.md', asset],
    ]) {
      const prepared = await prepareSecretSafeSend('gh', args);
      snapshots.push(prepared);
      assert.equal(readFileSync(prepared.args.at(-1), 'utf8'), 'safe asset');
      assert.notEqual(prepared.args.at(-1), asset);
    }
    const edit = ['gist', 'edit', 'gist-id', '-r', 'remote-file.md', '--desc', 'new description'];
    const prepared = await prepareSecretSafeSend('gh', edit);
    snapshots.push(prepared);
    assert.deepEqual(prepared.args, edit);
  });

  for (const [label, args] of [
    ['separate URL option', (url) => ['--url', url]],
    ['equals URL option', (url) => [`--url=${url}`]],
    ['encoded positional URL', (url) => [url.replace('.env.local', '%2eenv.local')]],
    ['uppercase file scheme', (url) => ['--url', url.replace('file:', 'FILE:')]],
    ['URL after option terminator', (url) => ['--', url]],
  ])
    it(`blocks a credential source in curl ${label}`, async () => {
      const source = join(dirname(file('ordinary file')), '.env.local');
      writeFileSync(source, secret());
      await assert.rejects(
        prepareSecretSafeSend('curl', args(pathToFileURL(source).href)),
        /credential_source_blocked_before_read/,
      );
    });

  it('freezes ordinary file URLs before curl can copy them outside stdout', async () => {
    const source = file('safe local resource');
    for (const args of [
      [pathToFileURL(source).href],
      ['--url', pathToFileURL(source).href],
      [`--url=${pathToFileURL(source).href}`],
    ]) {
      const prepared = await prepareSecretSafeSend('curl', args);
      snapshots.push(prepared);
      const frozen = fileURLToPath(prepared.args.at(-1));
      assert.notEqual(frozen, source);
      writeFileSync(source, 'replaced after preparation');
      assert.equal(readFileSync(frozen, 'utf8'), 'safe local resource');
      writeFileSync(source, 'safe local resource');
    }
  });

  it('inspects curl format and certificate input files as reads', async () => {
    for (const name of ['--write-out', '-w', '--cacert']) {
      const source = file(secret());
      const value = name === '--cacert' ? source : `@${source}`;
      await assert.rejects(
        prepareSecretSafeSend('curl', [name, value, 'https://example.invalid']),
        /secret_content_detected/,
      );
    }
  });

  it('does not expand curl flag-like text when it is an option value', async () => {
    const args = ['--data', '-sd@literal-inline-content', 'https://example.invalid'];
    const prepared = await prepareSecretSafeSend('curl', args);
    snapshots.push(prepared);
    assert.deepEqual(prepared.args, ['-q', ...args]);
  });

  it('resolves the action past selector and group options before classifying assets', async () => {
    const commands = [
      ['release', '-R', 'owner/repo', 'upload', 'v1'],
      ['release', '--repo=owner/repo', 'upload', 'v1'],
      ['release', '-Rowner/repo', 'new', 'v1', '-d'],
      ['-R', 'owner/repo', 'release', 'upload', 'v1'],
      ['release', 'upload', '-R', 'owner/repo', 'v1'],
      ['release', '--notes', 'upload', 'create', 'v1', '-d'],
      ['gist', '--desc', 'create', 'new'],
      ['gist', '--desc=edit', 'create'],
    ];
    for (const command of commands) {
      const source = file(secret());
      await assert.rejects(prepareSecretSafeSend('gh', [...command, source]), /secret_content_detected/);
      writeFileSync(source, 'safe asset');
      const prepared = await prepareSecretSafeSend('gh', [...command, source]);
      snapshots.push(prepared);
      assert.notEqual(prepared.args.at(-1), source);
      assert.equal(readFileSync(prepared.args.at(-1), 'utf8'), 'safe asset');
    }
  });

  it('refuses an unresolved command prefix instead of choosing a generic asset policy', async () => {
    await assert.rejects(
      prepareSecretSafeSend('gh', ['release', '--unclassified-prefix', 'upload', 'v1', file('safe')]),
      /secret_send_operation_unresolved/,
    );
  });
});
