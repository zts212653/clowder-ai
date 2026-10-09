import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const source = resolve('.');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'public-brand-policy-'));
  for (const path of [
    'scripts/intake-from-opensource.sh',
    'scripts/lib/intake-gh-retry.sh',
    'scripts/brand-dictionary-helper.mjs',
    'assets/brand-dictionary.yaml',
  ]) {
    mkdirSync(resolve(dir, path, '..'), { recursive: true });
    cpSync(resolve(source, path), resolve(dir, path));
  }
  // The new checker is copied only once it exists; RED must exercise the old entry.
  try {
    cpSync(resolve(source, 'scripts/public-brand-validation.mjs'), resolve(dir, 'scripts/public-brand-validation.mjs'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const write = (path, text) => {
    mkdirSync(resolve(dir, path, '..'), { recursive: true });
    writeFileSync(resolve(dir, path), text);
  };
  write(
    '.sync-provenance.json',
    JSON.stringify({ source_commit_sha: 'a'.repeat(40), target_head_sha: 'b'.repeat(40), manifest_version: 3 }),
  );
  write('packages/web/src/app/layout.tsx', 'Clowder AI Your AI team collaboration space favicon.svg icon-192x192.png');
  write(
    'packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts',
    "frontendBaseUrl: deps.frontendBaseUrl ?? 'http://localhost:3003'",
  );
  write('packages/web/public/icons/favicon.svg', '<svg/>');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const stage = () => execFileSync('git', ['add', '.'], { cwd: dir });
  const run = () =>
    spawnSync(
      'bash',
      ['scripts/intake-from-opensource.sh', '--validate-inbound', '--from-index', '--state-migration-advisory'],
      { cwd: dir, encoding: 'utf8', timeout: 30000 },
    );
  stage();
  return { dir, write, stage, run };
}

test('public export validates its staged brand and port instead of contradictory home rules', () => {
  const f = fixture();
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Public Brand Guard/);
});

test('public guard rejects staged home port even when worktree has corrected it', () => {
  const f = fixture();
  const path = 'packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts';
  f.write(path, "frontendBaseUrl: deps.frontendBaseUrl ?? 'http://localhost:3001'");
  f.stage();
  f.write(path, "frontendBaseUrl: deps.frontendBaseUrl ?? 'http://localhost:3003'");
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /public frontend port/);
});

test('invalid public provenance fails closed', () => {
  const f = fixture();
  f.write('.sync-provenance.json', '{}');
  f.stage();
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /provenance/);
});

test('public API fallback is checked even on a safe-cherry-pick path', () => {
  const f = fixture();
  f.write('packages/api/src/index.ts', "const port = process.env.API_SERVER_PORT ?? '3002';");
  f.stage();
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /public API fallback/);
});

test('large staged text is checked without truncation', () => {
  const f = fixture();
  f.write('assets/system-prompts/large.md', `${'x'.repeat(2 * 1024 * 1024)}猫猫咖啡`);
  f.stage();
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /home-only brand term/);
  assert.doesNotMatch(r.stdout + r.stderr, /ENOBUFS/);
});

test('home exporter keeps the existing inbound guard and rejects public branding', () => {
  const f = fixture();
  f.write('scripts/sync-to-opensource.sh', '# home exporter\n');
  f.stage();
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /contains 'Clowder AI'/);
  assert.doesNotMatch(r.stdout, /Public Brand Guard/);
});

test('staged dictionary contamination cannot be hidden by an unstaged repair', () => {
  const f = fixture();
  const path = 'assets/brand-dictionary.yaml';
  const original = readFileSync(resolve(f.dir, path), 'utf8');
  f.write(path, original.replace('        - "猫猫咖啡"', '        - "PrivateFixtureBrand"'));
  f.write('assets/system-prompts/fixture.md', 'PrivateFixtureBrand');
  f.stage();
  f.write(path, original);
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /home-only brand term PrivateFixtureBrand/);
});

test('missing dictionary policies fail closed', () => {
  const f = fixture();
  const path = 'assets/brand-dictionary.yaml';
  f.write(path, readFileSync(resolve(f.dir, path), 'utf8').split('\npath_policies:')[0]);
  f.stage();
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /dictionary.*polic/);
});

test('removing a tracked home exporter cannot switch the policy domain', () => {
  const f = fixture();
  f.write('scripts/sync-to-opensource.sh', '# home exporter\n');
  f.stage();
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Fixture baseline\n\nWhy: establish the home-domain history for the guard regression.',
    ],
    { cwd: f.dir },
  );
  execFileSync('git', ['rm', '--cached', 'scripts/sync-to-opensource.sh'], { cwd: f.dir });
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /home exporter must retain inbound policy/);
});

test('staged favicon removal is rejected even when the worktree copy remains', () => {
  const f = fixture();
  execFileSync('git', ['rm', '--cached', 'packages/web/public/icons/favicon.svg'], { cwd: f.dir });
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /favicon.svg.*must exist/);
});

for (const [name, path, body, diagnostic] of [
  ['SplitPane brand', 'packages/web/src/components/SplitPaneView.tsx', '<h1>猫猫咖啡</h1>', /missing Clowder AI/],
  [
    'layout tagline',
    'packages/web/src/app/layout.tsx',
    'Clowder AI favicon.svg icon-192x192.png',
    /missing Your AI team/,
  ],
  [
    'API client brand',
    'packages/web/src/utils/api-client.ts',
    'HttpOnly session cookie',
    /missing client for Clowder AI/,
  ],
  [
    'Weixin fallback',
    'packages/api/src/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.ts',
    "process.env.API_SERVER_PORT ?? '3002'",
    /public API fallback/,
  ],
  [
    'Weixin hardcoded port',
    'packages/api/src/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.ts',
    "process.env.API_SERVER_PORT ?? '3004'; const bad = 'http://localhost:3003'",
    /hardcoded localhost/,
  ],
]) {
  test(`public rule rejects ${name} drift`, () => {
    const f = fixture();
    f.write(path, body);
    f.stage();
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, diagnostic);
  });
}

test('mandatory source checks include the public guard regressions', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
  assert.match(scripts['check:brand-guard'], /\bscripts\/public-brand-validation\.test\.mjs\b/);
  assert.match(scripts['check:sources'], /(?:^|&&)\s*pnpm check:brand-guard(?:\s*&&|$)/);
  assert.match(scripts.check, /(?:^|&&)\s*pnpm check:sources(?:\s*&&|$)/);
});
