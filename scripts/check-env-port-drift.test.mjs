/**
 * Port drift guard — ensures .env.example.opensource ports stay consistent
 * with sync-to-opensource.sh transforms.
 *
 * Root cause of clowder-ai#87 / #55 / #56: the .env.example.opensource had
 * API_SERVER_PORT and FRONTEND_PORT swapped relative to the code defaults
 * that sync-to-opensource.sh produces. This test prevents that from recurring.
 *
 * Convention (set by _sanitize-rules.pl + sync-to-opensource.sh):
 *   Home:        API=3002, Frontend=3001
 *   Open-source: API=3003, Frontend=3004
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd());

// Detect repo context early — used by multiple describe blocks.
// Home repo has sync-to-opensource.sh; open-source repo does not.
const isHomeRepo = existsSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'));
const hasEnvExampleOpensource = existsSync(resolve(ROOT, '.env.example.opensource'));

function readEnvFile(relPath) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    vars[key] = val;
  }
  return vars;
}

function readScriptFallback(relPath, varName) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  // Match pattern: VAR=${ENV_NAME:-DEFAULT}
  const re = new RegExp(`${varName}=\\$\\{\\w+:-([^}]+)\\}`);
  const m = content.match(re);
  return m ? m[1] : null;
}

function readTsFallback(relPath, pattern) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const m = content.match(pattern);
  return m ? m[1] : null;
}

function readSyncScript() {
  return readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
}

function readFunctionBody(content, functionName) {
  const start = content.indexOf(`${functionName}() {`);
  assert.notEqual(start, -1, `expected to find function ${functionName} in sync-to-opensource.sh`);

  const end = content.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `expected to find the end of function ${functionName} in sync-to-opensource.sh`);

  return content.slice(start, end);
}

describe(
  '.env.example.opensource port consistency',
  { skip: !hasEnvExampleOpensource && '.env.example.opensource not present (open-source repo uses .env.example)' },
  () => {
    const env = readEnvFile('.env.example.opensource');

    it('API_SERVER_PORT matches sync convention (3003)', () => {
      assert.equal(
        env.API_SERVER_PORT,
        '3003',
        `API_SERVER_PORT should be 3003 (open-source convention), got ${env.API_SERVER_PORT}`,
      );
    });

    it('FRONTEND_PORT matches sync convention (3004)', () => {
      assert.equal(
        env.FRONTEND_PORT,
        '3004',
        `FRONTEND_PORT should be 3004 (open-source convention), got ${env.FRONTEND_PORT}`,
      );
    });

    it('NEXT_PUBLIC_API_URL uses API port (3003)', () => {
      assert.equal(
        env.NEXT_PUBLIC_API_URL,
        'http://localhost:3003',
        `NEXT_PUBLIC_API_URL should point to API port 3003, got ${env.NEXT_PUBLIC_API_URL}`,
      );
    });

    it('.env.example.opensource comment header documents correct ports', () => {
      const content = readFileSync(resolve(ROOT, '.env.example.opensource'), 'utf-8');
      // The comment should say frontend=3004, API=3003
      assert.ok(
        content.includes('3004') && content.includes('3003'),
        'Comment header should mention both 3003 and 3004',
      );
    });
  },
);

// In the home repo (cat-cafe), code defaults are 3002/3001.
// In the open-source repo (clowder-ai), sync transforms them to 3003/3004.
const expectedApiPort = isHomeRepo ? '3002' : '3003';
const expectedFrontendPort = isHomeRepo ? '3001' : '3004';
const repoLabel = isHomeRepo ? 'home' : 'open-source';

describe(`Code-side port defaults are internally consistent (${repoLabel}: API=${expectedApiPort}, Frontend=${expectedFrontendPort})`, () => {
  it(`start-dev.sh API fallback is ${expectedApiPort}`, () => {
    const fallback = readScriptFallback('scripts/start-dev.sh', 'API_PORT');
    assert.equal(
      fallback,
      expectedApiPort,
      `start-dev.sh API_PORT fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`start-dev.sh Frontend fallback is ${expectedFrontendPort}`, () => {
    const fallback = readScriptFallback('scripts/start-dev.sh', 'WEB_PORT');
    assert.equal(
      fallback,
      expectedFrontendPort,
      `start-dev.sh WEB_PORT fallback should be ${expectedFrontendPort}, got ${fallback}`,
    );
  });

  it(`index.ts API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback('packages/api/src/index.ts', /API_SERVER_PORT\s*\?\?\s*'(\d+)'/);
    assert.equal(fallback, expectedApiPort, `index.ts API fallback should be ${expectedApiPort}, got ${fallback}`);
  });

  it(`env-registry.ts API_SERVER_PORT defaultValue is ${expectedApiPort}`, () => {
    const fallback = readTsFallback(
      'packages/api/src/config/env-registry.ts',
      /name:\s*'API_SERVER_PORT',\s*defaultValue:\s*'(\d+)'/,
    );
    assert.equal(
      fallback,
      expectedApiPort,
      `env-registry API_SERVER_PORT default should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`ConfigRegistry.ts API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback('packages/api/src/config/ConfigRegistry.ts', /API_SERVER_PORT\s*\?\?\s*'(\d+)'/);
    assert.equal(
      fallback,
      expectedApiPort,
      `ConfigRegistry API fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`frontend-origin.ts DEFAULT_FRONTEND_BASE_URL uses port ${expectedFrontendPort}`, () => {
    const fallback = readTsFallback(
      'packages/api/src/config/frontend-origin.ts',
      /DEFAULT_FRONTEND_BASE_URL\s*=\s*'http:\/\/localhost:(\d+)'/,
    );
    assert.equal(
      fallback,
      expectedFrontendPort,
      `frontend-origin DEFAULT_FRONTEND_BASE_URL should use ${expectedFrontendPort}, got ${fallback}`,
    );
  });

  it(`setup.sh API_SERVER_PORT is ${expectedApiPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      content.includes(`API_SERVER_PORT=${expectedApiPort}`),
      `setup.sh should set API_SERVER_PORT=${expectedApiPort}`,
    );
  });

  it(`setup.sh FRONTEND_PORT is ${expectedFrontendPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      content.includes(`FRONTEND_PORT=${expectedFrontendPort}`),
      `setup.sh should set FRONTEND_PORT=${expectedFrontendPort}`,
    );
  });

  it(`setup.sh NEXT_PUBLIC_API_URL uses port ${expectedApiPort}`, () => {
    const content = readFileSync(resolve(ROOT, 'scripts/setup.sh'), 'utf-8');
    assert.ok(
      content.includes(`NEXT_PUBLIC_API_URL=http://localhost:${expectedApiPort}`),
      `setup.sh should set NEXT_PUBLIC_API_URL to localhost:${expectedApiPort}`,
    );
  });

  it(`runtime-worktree.sh API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback('scripts/runtime-worktree.sh', /API_SERVER_PORT:-(\d+)/);
    assert.equal(
      fallback,
      expectedApiPort,
      `runtime-worktree.sh API port fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });

  it(`AgentRouter.ts API port fallback is ${expectedApiPort}`, () => {
    const fallback = readTsFallback(
      'packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts',
      /API_SERVER_PORT\s*\?\?\s*'(\d+)'/,
    );
    assert.equal(
      fallback,
      expectedApiPort,
      `AgentRouter.ts API fallback should be ${expectedApiPort}, got ${fallback}`,
    );
  });
});

describe(
  'Sync transform rules match convention',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('_sanitize-rules.pl transforms 3002→3003 (API)', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
      assert.ok(
        content.includes('s#localhost:3002#localhost:3003#g'),
        'sanitize rules should transform localhost:3002 → localhost:3003',
      );
    });

    it('_sanitize-rules.pl transforms 3001→3004 (Frontend)', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf-8');
      assert.ok(
        content.includes('s#localhost:3001#localhost:3004#g'),
        'sanitize rules should transform localhost:3001 → localhost:3004',
      );
    });

    it('sync-to-opensource.sh transforms start-dev.sh API fallback to 3003', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      const expected = "'s/API_PORT=$" + '{API_SERVER_PORT:-3002}/API_PORT=$' + "{API_SERVER_PORT:-3003}/g'";
      assert.ok(content.includes(expected), 'sync script should transform start-dev.sh API fallback 3002→3003');
    });

    it('sync-to-opensource.sh transforms start-dev.sh Frontend fallback to 3004', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      const expected = "'s/WEB_PORT=$" + '{FRONTEND_PORT:-3001}/WEB_PORT=$' + "{FRONTEND_PORT:-3004}/g'";
      assert.ok(content.includes(expected), 'sync script should transform start-dev.sh Frontend fallback 3001→3004');
    });

    it('sync-to-opensource.sh transforms setup.sh API port to 3003', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("'s/API_SERVER_PORT=3002/API_SERVER_PORT=3003/g'"),
        'sync script should transform setup.sh API_SERVER_PORT 3002→3003',
      );
    });

    it('sync-to-opensource.sh transforms setup.sh Frontend port to 3004', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("'s/FRONTEND_PORT=3001/FRONTEND_PORT=3004/g'"),
        'sync script should transform setup.sh FRONTEND_PORT 3001→3004',
      );
    });

    it('sync-to-opensource.sh transforms runtime-worktree.sh API port to 3003', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("'s/API_SERVER_PORT:-3002/API_SERVER_PORT:-3003/g'"),
        'sync script should transform runtime-worktree.sh API port 3002→3003',
      );
    });

    it('sync-to-opensource.sh transforms AgentRouter.ts API port to 3003', () => {
      const content = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
      assert.ok(
        content.includes("process.env.API_SERVER_PORT ?? '3003'"),
        'sync script should transform AgentRouter.ts API port 3002→3003',
      );
    });
  },
);

describe(
  'Sync validation enforces static quality gates',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('validate mode stays aligned with post-sync static gates', () => {
      const content = readSyncScript();
      const staticGateFn = readFunctionBody(content, 'run_static_quality_gates');
      const validateBlock = content.match(
        /echo -e "\$\{GREEN\}\[Step 5\/6\] Validate \(install \+ static gates \+ build \+ port check\)\.\.\.\$\{NC\}"[\s\S]*?echo -e " {2}\$\{GREEN\}✓ Validate passed\$\{NC\}"/,
      )?.[0];

      assert.match(
        staticGateFn,
        /pnpm check:fix[\s\S]*pnpm check 2>&1[\s\S]*pnpm lint 2>&1/,
        'run_static_quality_gates should run pnpm check:fix → pnpm check → pnpm lint in order',
      );
      assert.ok(validateBlock, 'expected to find the validate block in sync-to-opensource.sh');
      assert.ok(
        validateBlock.includes('run_static_quality_gates false'),
        'validate mode should invoke the same non-mutating static gates as the post-sync path',
      );
    });

    it('post-sync fast/full validation keeps static gates before startup acceptance split', () => {
      const content = readSyncScript();
      const step6Block = content.match(/# 6b: Install \+ build[\s\S]*?if \[ "\$FAST_VALIDATE" = true \]; then/)?.[0];

      assert.ok(step6Block, 'expected to find the Step 6 validation block in sync-to-opensource.sh');
      assert.ok(
        step6Block.includes('run_static_quality_gates false'),
        'Step 6 should invoke run_static_quality_gates with autofix disabled',
      );
      assert.ok(
        step6Block.indexOf('run_static_quality_gates false') <
          step6Block.indexOf('if [ "$FAST_VALIDATE" = true ]; then'),
        '--fast-validate should only skip startup acceptance, not static gates',
      );
    });
  },
);
