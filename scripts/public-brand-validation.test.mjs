import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { projectDeploymentProfiles } from '../packages/shared/src/deployment-defaults.ts';

const source = resolve('.');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'public-brand-policy-'));
  for (const path of [
    'scripts/intake-from-opensource.sh',
    'scripts/lib/intake-gh-retry.sh',
    'scripts/lib/intake-brand-paths.mjs',
    'scripts/brand-dictionary-helper.mjs',
    'scripts/deployment-brand-config.mjs',
    'scripts/project-deployment-defaults.mjs',
    'assets/brand-dictionary.yaml',
    'packages/shared/src/deployment-defaults.ts',
    'packages/shared/src/deployment-profiles.json',
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
  const defaultsFile = 'packages/shared/src/deployment-profiles.json';
  write(
    defaultsFile,
    JSON.stringify(
      projectDeploymentProfiles(JSON.parse(readFileSync(resolve(dir, defaultsFile), 'utf8')), 'opensource'),
    ),
  );
  // Public intake carries public branding; do not stage the home script's comments as public data.
  write(
    'scripts/intake-from-opensource.sh',
    readFileSync(resolve(dir, 'scripts/intake-from-opensource.sh'), 'utf8')
      .replaceAll('Clowder AI', 'Clowder AI')
      .replaceAll('Clowder AI', 'Clowder AI'),
  );
  write(
    '.sync-provenance.json',
    JSON.stringify({ source_commit_sha: 'a'.repeat(40), target_head_sha: 'b'.repeat(40), manifest_version: 3 }),
  );
  write(
    'packages/web/src/app/layout.tsx',
    'deploymentDefaults.brand.name deploymentDefaults.brand.tagline favicon.svg icon-192x192.png',
  );
  write('packages/api/src/config/frontend-origin.ts', "const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3003'");
  write('packages/web/public/icons/favicon.svg', '<svg/>');
  write('docs/ROADMAP.md', '# Roadmap\n');
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

test('public guard rejects staged brand drift despite an unstaged repair', () => {
  const f = fixture();
  const path = 'packages/shared/src/deployment-profiles.json';
  const original = readFileSync(resolve(f.dir, path), 'utf8');
  const input = JSON.parse(original);
  input.profiles.opensource.brand.name = 'Unrelated product';
  f.write(path, JSON.stringify(input));
  f.stage();
  f.write(path, original);
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /brand.*canonical dictionary/i);
});

test('public guard reads staged dictionary display values, not an unstaged repair', () => {
  const f = fixture();
  const path = 'assets/brand-dictionary.yaml';
  const original = readFileSync(resolve(f.dir, path), 'utf8');
  // Public sanitization can make home/public labels identical. Mutate the
  // selected dictionary side, never the first matching display literal.
  const changed = original.replace(
    /(^ {2}- id: product[.]primary[\s\S]*?^ {4}public:[\s\S]*?^ {6}display:)[^\n]*/m,
    '$1 "Synthetic changed display"',
  );
  assert.notEqual(changed, original);
  f.write(path, changed);
  f.stage();
  f.write(path, original);
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /canonical dictionary/);
});

test('public guard rejects a stale staged PWA brand despite an unstaged repair', () => {
  const f = fixture();
  const path = 'packages/web/public/manifest.json';
  const config = JSON.parse(readFileSync(resolve(f.dir, 'packages/shared/src/deployment-profiles.json'), 'utf8'));
  const brand = config.profiles.opensource.brand;
  f.write(path, JSON.stringify({ name: 'Unrelated product', short_name: brand.shortName, description: brand.tagline }));
  f.stage();
  f.write(path, JSON.stringify({ name: brand.displayName, short_name: brand.shortName, description: brand.tagline }));
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /manifest name differs/);
});

test('public guard rejects a missing staged roadmap even when the worktree restores it', () => {
  const f = fixture();
  execFileSync('git', ['rm', '--cached', 'docs/ROADMAP.md'], { cwd: f.dir });
  assert.ok(readFileSync(resolve(f.dir, 'docs/ROADMAP.md'), 'utf8'));
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /roadmap.*must exist/i);
});

test('public guard requires its staged deployment configuration', () => {
  const f = fixture();
  execFileSync('git', ['rm', '--cached', 'packages/shared/src/deployment-profiles.json'], { cwd: f.dir });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /deployment defaults.*must exist/);
});

test('public guard also rejects missing roadmap artifacts in worktree validation', () => {
  const f = fixture();
  unlinkSync(resolve(f.dir, 'docs/ROADMAP.md'));
  const result = spawnSync('node', ['scripts/public-brand-validation.mjs'], {
    cwd: f.dir,
    encoding: 'utf8',
    input: '[]',
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /roadmap.*must exist/i);
});

for (const target of ['../packages/shared/src/deployment-profiles.json', 'MISSING.md']) {
  for (const fromIndex of [true, false]) {
    test(`public guard rejects ${target} roadmap symlink in ${fromIndex ? 'index' : 'worktree'}`, () => {
      const f = fixture();
      const path = resolve(f.dir, 'docs/ROADMAP.md');
      unlinkSync(path);
      symlinkSync(target, path);
      if (fromIndex) {
        f.stage();
        assert.match(
          execFileSync('git', ['ls-files', '--stage', '--', 'docs/ROADMAP.md'], { cwd: f.dir, encoding: 'utf8' }),
          /^120000 /,
        );
        // A valid worktree replacement must not hide the staged symlink.
        unlinkSync(path);
        f.write('docs/ROADMAP.md', '# Roadmap\n');
      }
      const result = spawnSync(
        'node',
        ['scripts/public-brand-validation.mjs', ...(fromIndex ? ['--from-index'] : [])],
        {
          cwd: f.dir,
          encoding: 'utf8',
          input: '[]',
        },
      );
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /roadmap.*regular file/i);
    });
  }
}

test('public worktree guard rejects a symlinked roadmap parent directory', () => {
  const f = fixture();
  renameSync(resolve(f.dir, 'docs'), resolve(f.dir, 'other-docs'));
  symlinkSync('other-docs', resolve(f.dir, 'docs'));
  const result = spawnSync('node', ['scripts/public-brand-validation.mjs'], {
    cwd: f.dir,
    encoding: 'utf8',
    input: '[]',
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /roadmap.*regular file/i);
});

test('public guard rejects staged document-coordinate drift despite an unstaged repair', () => {
  const f = fixture();
  const path = 'packages/shared/src/deployment-profiles.json';
  const original = readFileSync(resolve(f.dir, path), 'utf8');
  const input = JSON.parse(original);
  input.profiles.opensource.roadmapPath = 'docs/MISSING.md';
  f.write(path, JSON.stringify(input));
  f.stage();
  f.write(path, original);
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /roadmapPath.*artifact/);
});

test('public guard rejects staged home port even when worktree has corrected it', () => {
  const f = fixture();
  const path = 'packages/api/src/config/frontend-origin.ts';
  f.write(path, "const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3001'");
  f.stage();
  f.write(path, "const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3003'");
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

test('public guard rejects malformed JSON path scopes instead of skipping staged validation', () => {
  const f = fixture();
  for (const input of ['[', '[17]', '[null]', '["bad\\u0000path"]']) {
    const result = spawnSync('node', ['scripts/public-brand-validation.mjs', '--from-index'], {
      cwd: f.dir,
      encoding: 'utf8',
      input,
    });
    assert.notEqual(result.status, 0, input);
  }
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
  assert.match(r.stdout + r.stderr, /Expected home deployment profile/);
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
  [
    'SplitPane brand',
    'packages/web/src/components/SplitPaneView.tsx',
    '<h1>猫猫咖啡</h1>',
    /missing deploymentDefaults.brand.name/,
  ],
  [
    'layout tagline',
    'packages/web/src/app/layout.tsx',
    'Clowder AI favicon.svg icon-192x192.png',
    /missing deploymentDefaults.brand.tagline/,
  ],
  [
    'API client brand',
    'packages/web/src/utils/api-client.ts',
    'HttpOnly session cookie',
    /missing client for Clowder AI/,
  ],
  [
    'Agent API fallback',
    'packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts',
    "process.env.API_SERVER_PORT ?? '3002'",
    /public API fallback/,
  ],
  [
    'frontend default with unrelated public URL',
    'packages/api/src/config/frontend-origin.ts',
    "const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3001'; const other = 'http://localhost:3003'",
    /public frontend port/,
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

test('public configured frontend default checks staged profile data and rejects a home profile', () => {
  const f = fixture();
  f.write(
    'packages/api/src/config/frontend-origin.ts',
    "import { deploymentDefaults } from '@cat-cafe/shared';\nconst DEFAULT_FRONTEND_BASE_URL = deploymentDefaults.frontendBaseUrl;",
  );
  const file = 'packages/shared/src/deployment-profiles.json';
  const config = {
    schemaVersion: 1,
    activeProfile: 'opensource',
    profiles: {
      opensource: {
        apiPort: 3004,
        webPort: 3003,
        envRegistryFrontendPort: 3003,
        corsOrigins: ['http://localhost:3003'],
        roadmapPath: 'docs/ROADMAP.md',
        repositoryFullName: JSON.parse(
          readFileSync(resolve(source, 'packages/shared/src/deployment-profiles.json'), 'utf8'),
        ).profiles.opensource.repositoryFullName,
        brand: JSON.parse(readFileSync(resolve(source, 'packages/shared/src/deployment-profiles.json'), 'utf8'))
          .profiles.opensource.brand,
      },
    },
  };
  f.write(file, JSON.stringify(config));
  f.stage();
  let result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  f.write(file, JSON.stringify({ ...config, activeProfile: 'home', profiles: { home: config.profiles.opensource } }));
  f.stage();
  f.write(file, JSON.stringify(config));
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Expected opensource deployment profile/);
});
