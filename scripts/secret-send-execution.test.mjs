import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const roots = [];
const secret = () => ['ghp', '_', 'Z'.repeat(36)].join('');
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(program) {
  const dir = mkdtempSync(join(tmpdir(), 'send-execution-'));
  roots.push(dir);
  const body = join(dir, 'body.md');
  const receipt = join(dir, 'receipt.json');
  const delegate = join(dir, program);
  writeFileSync(
    delegate,
    `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst args=process.argv.slice(2); const path=args.at(-1).replace(/^@/, '');\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({args, body:readFileSync(path,'utf8')}));\nprocess.stdout.write('normal output\\n');\n`,
  );
  chmodSync(delegate, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CAT_CAFE_')));
  return { dir, body, receipt, delegate, env: { ...env, PATH: `${dir}:${env.PATH}`, CAT_CAFE_REAL_GH_PATH: delegate } };
}

for (const [program, prefix] of [
  ['gh', ['issue', 'comment', '1', '--body-file']],
  ['gh', ['pr', 'review', '123', '-a', '-F']],
  ['curl', null],
])
  test(`${program} ${prefix?.join(' ') ?? 'upload'} scans before a real delegate execution and only sends frozen bytes`, () => {
    const f = fixture(program);
    const args = prefix ? [...prefix, f.body] : ['https://example.invalid', '--data-binary', `@${f.body}`];
    writeFileSync(f.body, secret());
    const blocked = spawnSync(resolve('scripts/guarded-bin', program), args, {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    });
    assert.equal(blocked.status, 1);
    assert.ok(!existsSync(f.receipt));
    assert.ok(!`${blocked.stdout}${blocked.stderr}`.includes(secret()));
    writeFileSync(f.body, 'safe body');
    const clean = spawnSync(resolve('scripts/guarded-bin', program), args, {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    });
    assert.equal(clean.status, 0, clean.stderr);
    const sent = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(sent.body, 'safe body');
    assert.notEqual(sent.args.at(-1).replace(/^@/, ''), f.body);
    assert.ok(!existsSync(sent.args.at(-1).replace(/^@/, '')));
  });

test('delegate output is redacted before reaching the native shell result', () => {
  const f = fixture('gh');
  writeFileSync(
    f.delegate,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(secret())}); process.stderr.write(${JSON.stringify(secret())});\n`,
  );
  const result = spawnSync(resolve('scripts/guarded-bin/gh'), ['pr', 'view', '1'], {
    cwd: f.dir,
    env: f.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret()));
  assert.match(`${result.stdout}${result.stderr}`, /轮转|rotate/);
});

for (const program of ['gh', 'curl'])
  for (const stream of ['stdout', 'stderr'])
    test(`${program} flushes complete binary ${stream} through a real pipe before reporting exit`, () => {
      const f = fixture(program);
      const size = 256 * 1024 + 137;
      const status = stream === 'stderr' ? 7 : 0;
      writeFileSync(
        f.delegate,
        `#!${process.execPath}\nconst payload=Buffer.alloc(${size});\nfor(let i=0;i<payload.length;i++)payload[i]=i%256;\nprocess.${stream}.write(payload);\nprocess.exitCode=${status};\n`,
      );
      const expected = Buffer.alloc(size);
      for (let i = 0; i < expected.length; i++) expected[i] = i % 256;
      const args =
        program === 'gh'
          ? ['api', 'repos/fixture/project/actions/artifacts/1/zip']
          : ['https://example.invalid/archive'];
      const result = spawnSync(resolve('scripts/guarded-bin', program), args, {
        cwd: f.dir,
        env: f.env,
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(result.status, status, 'preserve the delegate exit status after flushing its output');
      assert.equal(result[stream].length, size, `${stream} must not be cut at the pipe buffer boundary`);
      const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
      assert.equal(digest(result[stream]), digest(expected), 'preserve every binary byte');
    });

test('release draft assets are rejected before the upload delegate executes', () => {
  const f = fixture('gh');
  writeFileSync(f.body, secret());
  const result = spawnSync(resolve('scripts/guarded-bin/gh'), ['release', 'create', 'v1', '-d', f.body], {
    cwd: f.dir,
    env: f.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.ok(!existsSync(f.receipt));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret()));
  writeFileSync(f.body, 'safe release asset');
  const clean = spawnSync(resolve('scripts/guarded-bin/gh'), ['release', 'create', 'v1', '-d', f.body], {
    cwd: f.dir,
    env: f.env,
    encoding: 'utf8',
  });
  assert.equal(clean.status, 0, clean.stderr);
  const uploaded = JSON.parse(readFileSync(f.receipt, 'utf8'));
  assert.equal(uploaded.body, 'safe release asset');
  assert.notEqual(uploaded.args.at(-1), f.body);
});

test('the real curl cannot copy an explicit credential URL into an output file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curl-file-copy-'));
  roots.push(dir);
  const source = join(dir, '.env.local');
  const destination = join(dir, 'copied.txt');
  writeFileSync(source, secret());
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CAT_CAFE_')));
  const result = spawnSync(resolve('scripts/guarded-bin/curl'), ['--url', `file://${source}`, '-o', destination], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.ok(!existsSync(destination));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret()));
  const cleanSource = join(dir, 'ordinary.txt');
  writeFileSync(cleanSource, 'safe local resource');
  const clean = spawnSync(resolve('scripts/guarded-bin/curl'), ['--url', `file://${cleanSource}`, '-o', destination], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(readFileSync(destination, 'utf8'), 'safe local resource');
});
