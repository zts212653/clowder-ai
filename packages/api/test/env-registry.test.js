/**
 * F12: env-registry + GET /api/config/env-summary tests
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  buildEnvSummary,
  buildSectionEnvSummary,
  buildSystemEnvSummary,
  ENV_CATEGORIES,
  ENV_SECTION_KEYS,
  ENV_VARS,
  getEnvVarSections,
  hasSensitiveEditableVars,
  inferEnvControl,
  isEditableEnvVar,
  isEditableEnvVarName,
  isSensitiveEditableEnvVar,
  maskUrlCredentials,
  parseBoolEnv,
  SECTION_PROJECTION,
  SETTINGS_GROUPS,
  SYSTEM_VARS,
} from '../dist/config/env-registry.js';
import {
  ENV_SECTION_LABELS,
  filterEnvSummaryForSection,
  MODULE_SECTION_PROJECTION,
} from '../dist/config/env-sections.js';

// Save and restore env vars around tests
const savedEnv = {};
const BOOTSTRAP_ONLY_NEXT_PUBLIC_VARS = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_WHISPER_URL',
  'NEXT_PUBLIC_LLM_POSTPROCESS_URL',
  'NEXT_PUBLIC_PROJECT_ROOT',
  'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI',
];
const DEPRECATED_ENV_VARS = [
  'MODE_SWITCH_REQUIRES_APPROVAL',
  'GITHUB_REVIEW_IMAP_USER',
  'GITHUB_REVIEW_IMAP_PASS',
  'GITHUB_REVIEW_IMAP_HOST',
  'GITHUB_REVIEW_IMAP_PORT',
  'GITHUB_REVIEW_POLL_INTERVAL_MS',
  'GITHUB_REVIEW_IMAP_PROXY',
];

function setEnv(key, value) {
  savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('env-registry', () => {
  afterEach(() => restoreEnv());

  it('exports at least 20 env var definitions', () => {
    assert.ok(ENV_VARS.length >= 20, `Expected >= 20, got ${ENV_VARS.length}`);
  });

  it('has no duplicate env var names', () => {
    const names = ENV_VARS.map((v) => v.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Duplicate names found: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('every env var has a valid category', () => {
    const validCategories = Object.keys(ENV_CATEGORIES);
    for (const def of ENV_VARS) {
      assert.ok(validCategories.includes(def.category), `${def.name} has invalid category: ${def.category}`);
    }
  });

  it('OPENAI_API_KEY is marked sensitive', () => {
    const apiKey = ENV_VARS.find((v) => v.name === 'OPENAI_API_KEY');
    assert.ok(apiKey, 'OPENAI_API_KEY should be in registry');
    assert.equal(apiKey.sensitive, true);
  });

  it('registers KIMI_QUOTA_API_FALLBACK_ENABLED as bootstrap-only quota config', () => {
    const def = ENV_VARS.find((v) => v.name === 'KIMI_QUOTA_API_FALLBACK_ENABLED');
    assert.ok(def, 'KIMI_QUOTA_API_FALLBACK_ENABLED should be in registry');
    assert.equal(def.category, 'quota');
    assert.equal(def.runtimeEditable, false);
    assert.equal(def.hubVisible, false);
  });

  it('registers KIMI_CONFIG_FILE as bootstrap-only kimi config', () => {
    const def = ENV_VARS.find((v) => v.name === 'KIMI_CONFIG_FILE');
    assert.ok(def, 'KIMI_CONFIG_FILE should be in registry');
    assert.equal(def.category, 'kimi');
    assert.equal(def.runtimeEditable, false);
    assert.equal(def.hubVisible, false);
  });

  it('exposes official quota credential configuration in Hub as bootstrap-only paths', () => {
    const summaryNames = new Set(buildEnvSummary().map((entry) => entry.name));
    for (const name of ['QUOTA_OFFICIAL_REFRESH_ENABLED', 'CLAUDE_CREDENTIALS_PATH', 'CODEX_CREDENTIALS_PATH']) {
      const def = ENV_VARS.find((entry) => entry.name === name);
      assert.ok(def, `${name} should be registered`);
      assert.ok(summaryNames.has(name), `${name} should be visible in Hub`);
    }
    for (const name of ['CLAUDE_CREDENTIALS_PATH', 'CODEX_CREDENTIALS_PATH']) {
      const def = ENV_VARS.find((entry) => entry.name === name);
      assert.equal(def.runtimeEditable, false, `${name} should require restart instead of a misleading hot edit`);
    }
  });

  it('documents connector autostart as wrapper process authority rather than dotenv configuration', () => {
    const def = ENV_VARS.find((v) => v.name === 'CONNECTOR_GATEWAY_AUTOSTART');

    assert.ok(def, 'CONNECTOR_GATEWAY_AUTOSTART should be in registry');
    assert.doesNotMatch(def.description, /\.env/);
    assert.match(def.description, /启动进程环境|wrapper/);
  });

  it('REDIS_URL has maskMode url', () => {
    const redis = ENV_VARS.find((v) => v.name === 'REDIS_URL');
    assert.ok(redis, 'REDIS_URL should be in registry');
    assert.equal(redis.maskMode, 'url');
  });

  it('keeps API server port bootstrap-only while allowing preview gateway hot edits', () => {
    const apiPort = ENV_VARS.find((v) => v.name === 'API_SERVER_PORT');
    const previewPort = ENV_VARS.find((v) => v.name === 'PREVIEW_GATEWAY_PORT');
    assert.ok(apiPort, 'API_SERVER_PORT should be in registry');
    assert.ok(previewPort, 'PREVIEW_GATEWAY_PORT should be in registry');
    assert.equal(apiPort.runtimeEditable, false);
    assert.equal(previewPort.runtimeEditable, true);
  });

  it('marks CAT_TEMPLATE_PATH and REDIS_URL as bootstrap-only in hub env editor', () => {
    const templatePath = ENV_VARS.find((v) => v.name === 'CAT_TEMPLATE_PATH');
    const redisUrl = ENV_VARS.find((v) => v.name === 'REDIS_URL');
    assert.ok(templatePath, 'CAT_TEMPLATE_PATH should be in registry');
    assert.ok(redisUrl, 'REDIS_URL should be in registry');
    assert.equal(templatePath.runtimeEditable, false);
    assert.equal(redisUrl.runtimeEditable, false);
  });

  it('registers the F255 awakened lease as bootstrap-only runtime configuration', () => {
    const lease = ENV_VARS.find((v) => v.name === 'CAT_CAFE_F255_AWAKENED_LEASE_MS');
    assert.ok(lease, 'CAT_CAFE_F255_AWAKENED_LEASE_MS should be in registry');
    assert.equal(lease.defaultValue, '5400000');
    assert.equal(lease.runtimeEditable, false);
  });

  it('registers the Codex OAuth transport rollback as a hot-editable enum', () => {
    const transport = ENV_VARS.find((v) => v.name === 'CAT_CAFE_CODEX_OAUTH_TRANSPORT');
    assert.ok(transport, 'CAT_CAFE_CODEX_OAUTH_TRANSPORT should be in registry');
    assert.equal(transport.defaultValue, 'builtin');
    assert.equal(transport.runtimeEditable, true);
    assert.deepEqual(transport.allowedValues, ['builtin', 'https']);
  });

  it('marks client-bundled NEXT_PUBLIC vars as bootstrap-only in the hub env editor', () => {
    for (const name of BOOTSTRAP_ONLY_NEXT_PUBLIC_VARS) {
      const envVar = ENV_VARS.find((v) => v.name === name);
      assert.ok(envVar, `${name} should be in registry`);
      assert.equal(envVar.runtimeEditable, false, `${name} should be bootstrap-only`);
    }
  });

  it('no HINDSIGHT_* vars remain after D-1 cleanup', () => {
    const hindsightVars = ENV_VARS.filter((v) => v.name.startsWith('HINDSIGHT_'));
    assert.equal(hindsightVars.length, 0, 'All HINDSIGHT_* vars should be removed');
  });

  it('marks GITHUB_MCP_PAT as sensitive + editable; F102_API_KEY stays sensitive but UI-read-only-opt-in (#770)', () => {
    const githubMcpPat = ENV_VARS.find((v) => v.name === 'GITHUB_MCP_PAT');
    assert.ok(githubMcpPat, 'GITHUB_MCP_PAT should be in registry');
    assert.equal(githubMcpPat.sensitive, true);
    assert.equal(githubMcpPat.runtimeEditable, true);
    assert.ok(isSensitiveEditableEnvVar(githubMcpPat));

    const f102 = ENV_VARS.find((v) => v.name === 'F102_API_KEY');
    assert.ok(f102, 'F102_API_KEY should be in registry');
    assert.equal(f102.sensitive, true);
    assert.equal(f102.runtimeEditable, true);
    assert.equal(f102.targetWritePolicy, 'read-only-opt-in');
    // API editability stays true so the existing owner/session gate remains
    // the single authority for sensitive writes (see sensitive-env-write.test.js).
    assert.ok(isEditableEnvVar(f102), 'F102_API_KEY stays API-editable behind owner gate');
    assert.ok(isSensitiveEditableEnvVar(f102), 'F102_API_KEY is still sensitive-editable for owner gate');

    // #340 P6: OPENAI_API_KEY is no longer runtimeEditable (managed by accounts system)
    const openai = ENV_VARS.find((v) => v.name === 'OPENAI_API_KEY');
    assert.ok(openai, 'OPENAI_API_KEY should still be in registry');
    assert.equal(openai.sensitive, true, 'OPENAI_API_KEY should remain sensitive');
    assert.ok(!openai.runtimeEditable, 'OPENAI_API_KEY should not be runtimeEditable');
  });

  it('hasSensitiveEditableVars detects whitelisted sensitive vars', () => {
    assert.ok(hasSensitiveEditableVars(['GITHUB_MCP_PAT']));
    assert.ok(hasSensitiveEditableVars(['GITHUB_MCP_PAT', 'FRONTEND_URL']));
    assert.ok(!hasSensitiveEditableVars(['FRONTEND_URL', 'CAT_CAFE_CALLBACK_OUTBOX_DIR']));
    assert.ok(hasSensitiveEditableVars(['F102_API_KEY']), 'F102_API_KEY is API-editable behind owner gate');
    assert.ok(!hasSensitiveEditableVars(['OPENAI_API_KEY']), 'OPENAI_API_KEY is no longer editable (#340 P6)');
  });

  it('marks DEFAULT_OWNER_USER_ID as non-editable (trust anchor)', () => {
    const def = ENV_VARS.find((v) => v.name === 'DEFAULT_OWNER_USER_ID');
    assert.ok(def, 'DEFAULT_OWNER_USER_ID should be in registry');
    assert.equal(def.runtimeEditable, false, 'trust anchor must not be editable from Hub');
  });

  it('locks startup-only telemetry vars as non-editable and hot-reloadable ones as editable (F153 Phase K)', () => {
    const STARTUP_ONLY = [
      'OTEL_SDK_DISABLED',
      'TELEMETRY_HMAC_SALT',
      'PROMETHEUS_PORT',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'TELEMETRY_EXPORT_RAW_SYSTEM_IDS',
      // BurnRateMonitor caches thresholds at construction — env change
      // without restart has no effect (cloud review P1, PR #2594).
      'TELEMETRY_ALERT_ERROR_RATE',
      'TELEMETRY_ALERT_P95_LATENCY_S',
      'TELEMETRY_ALERT_ACTIVE_INVOCATIONS',
    ];
    const HOT_RELOADABLE = ['PROMPT_CAPTURE', 'PROMPT_CAPTURE_CATS'];
    for (const name of STARTUP_ONLY) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, false, `${name} is startup-only — must not be editable from Hub`);
      assert.equal(isEditableEnvVar(def), false, `${name} must be rejected by isEditableEnvVar`);
    }
    for (const name of HOT_RELOADABLE) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, true, `${name} is hot-reloadable — must be editable from Hub`);
      assert.equal(isEditableEnvVar(def), true, `${name} must pass isEditableEnvVar`);
    }
  });
});

describe('#770: curated System Settings projection', () => {
  afterEach(() => restoreEnv());

  it('fails closed unless runtime editing is explicitly enabled', () => {
    const undeclared = ENV_VARS.filter((definition) => definition.runtimeEditable === undefined);
    assert.ok(undeclared.length > 0, 'fixture should include undeclared registry entries');
    for (const definition of undeclared) {
      assert.equal(isEditableEnvVar(definition), false, `${definition.name} must not be implicitly editable`);
    }
  });

  it('defines exactly 25 registered, labelled, grouped, explicitly classified System variables', () => {
    assert.equal(SYSTEM_VARS.size, 25);
    for (const name of SYSTEM_VARS) {
      const definition = ENV_VARS.find((candidate) => candidate.name === name);
      assert.ok(definition, `${name} must remain in the full registry`);
      assert.ok(definition.label, `${name} must have a user-facing label`);
      assert.ok(definition.settingsGroup, `${name} must have a settings group`);
      assert.equal(typeof definition.runtimeEditable, 'boolean', `${name} must have explicit editability`);
    }
  });

  it('keeps security-boundary variables read-only', () => {
    for (const name of [
      'PROJECT_ALLOWED_ROOTS',
      'PROJECT_ALLOWED_ROOTS_APPEND',
      'PROJECT_DENIED_ROOTS',
      'DEFAULT_OWNER_USER_ID',
    ]) {
      const definition = ENV_VARS.find((candidate) => candidate.name === name);
      assert.ok(definition, `${name} must remain registered`);
      assert.equal(definition.runtimeEditable, false);
      assert.equal(definition.settingsGroup, 'security');
    }
  });

  it('projects DEFAULT_OWNER_USER_ID as a restart-required trust anchor without opening a write path', () => {
    const definition = ENV_VARS.find((candidate) => candidate.name === 'DEFAULT_OWNER_USER_ID');
    assert.ok(definition, 'DEFAULT_OWNER_USER_ID must remain registered');
    assert.ok(SYSTEM_VARS.has(definition.name), 'trust anchor must be visible in the curated System surface');
    assert.equal(definition.runtimeEditable, false, 'trust anchor must remain fail-closed for generic env writes');
    assert.equal(isEditableEnvVar(definition), false);
    assert.equal(definition.settingsGroup, 'security');
    assert.equal(definition.restartRequired, true);
    assert.ok(definition.label, 'trust anchor needs a user-facing label');
    assert.match(definition.description, /单用户/, 'read-only projection must explain unset single-user semantics');
  });

  it('builds a System summary without shrinking the canonical registry', () => {
    const summary = buildSystemEnvSummary();
    assert.equal(summary.length, SYSTEM_VARS.size);
    assert.ok(ENV_VARS.length > summary.length, 'full registry must remain broader than the curated surface');
    for (const variable of summary) {
      assert.ok(SYSTEM_VARS.has(variable.name), `${variable.name} must be curated`);
    }
  });

  it('publishes the five display groups', () => {
    assert.deepEqual(Object.keys(SETTINGS_GROUPS), ['network', 'storage', 'lifecycle', 'runtime', 'security']);
  });

  it('parses the shared boolean convention', () => {
    assert.equal(parseBoolEnv('1'), true);
    assert.equal(parseBoolEnv('TRUE'), true);
    assert.equal(parseBoolEnv('0'), false);
    assert.equal(parseBoolEnv(undefined), false);
    assert.equal(parseBoolEnv(undefined, true), true);
  });
});

describe('#770: deprecated env metadata', () => {
  it('retains every known dead config in the canonical registry with a reason', () => {
    for (const name of DEPRECATED_ENV_VARS) {
      const definition = ENV_VARS.find((candidate) => candidate.name === name);
      assert.ok(definition, `${name} must remain in the canonical registry`);
      assert.equal(typeof definition.deprecated, 'string', `${name} must expose deprecated metadata`);
      assert.ok(definition.deprecated.length > 0, `${name} deprecated reason must be non-empty`);
    }
  });

  it('keeps every deprecated config out of both runtime writes and the curated System surface', () => {
    for (const definition of ENV_VARS) {
      if (!definition.deprecated) continue;
      assert.equal(isEditableEnvVar(definition), false, `${definition.name} must not become runtime-editable`);
      assert.ok(!SYSTEM_VARS.has(definition.name), `${definition.name} must not appear in System Settings`);
    }
  });

  it('passes deprecated metadata through the API summary consumed by the existing frontend badge', () => {
    const summary = buildEnvSummary();
    const visibleDeprecated = summary.filter((entry) => typeof entry.deprecated === 'string');
    assert.ok(visibleDeprecated.length > 0, 'at least one deprecated var must reach the API payload');
    for (const name of DEPRECATED_ENV_VARS) {
      const definition = ENV_VARS.find((candidate) => candidate.name === name);
      const entry = summary.find((candidate) => candidate.name === name);
      if (definition?.hubVisible === false) continue;
      assert.equal(entry?.deprecated, definition?.deprecated, `${name} metadata must survive summary projection`);
    }
  });
});

describe('#770: GET /api/config/env-summary?surface=system', () => {
  it('returns only curated variables while leaving the full response unchanged', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();

      const curated = await app.inject({ method: 'GET', url: '/api/config/env-summary?surface=system' });
      assert.equal(curated.statusCode, 200);
      const curatedBody = JSON.parse(curated.payload);
      assert.deepEqual(curatedBody.groups, SETTINGS_GROUPS);
      assert.equal(curatedBody.variables.length, SYSTEM_VARS.size);
      assert.equal(curatedBody.categories, undefined);
      assert.equal(curatedBody.paths, undefined);
      const owner = curatedBody.variables.find((entry) => entry.name === 'DEFAULT_OWNER_USER_ID');
      assert.ok(owner, 'curated API surface must include the owner trust anchor');
      assert.equal(owner.runtimeEditable, false);
      assert.equal(owner.settingsGroup, 'security');
      assert.equal(owner.restartRequired, true);

      const full = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      assert.equal(full.statusCode, 200);
      const fullBody = JSON.parse(full.payload);
      assert.ok(fullBody.variables.length > SYSTEM_VARS.size);
      assert.ok(fullBody.categories);
      assert.ok(fullBody.paths);
      assert.ok(
        fullBody.variables.some((entry) => typeof entry.deprecated === 'string'),
        'full API surface must carry deprecated metadata to the existing frontend badge',
      );
    } finally {
      await app.close();
    }
  });
});

describe('maskUrlCredentials', () => {
  it('masks user:password in redis URL', () => {
    const result = maskUrlCredentials('redis://user:super-secret@localhost:6399/15');
    assert.ok(!result.includes('super-secret'), `Leaked password: ${result}`);
    assert.ok(result.includes('localhost:6399'), `Lost host: ${result}`);
    assert.ok(result.includes('/15'), `Lost db: ${result}`);
  });

  it('preserves URL without credentials', () => {
    const result = maskUrlCredentials('redis://localhost:6399');
    assert.ok(result.includes('localhost:6399'), `Lost host: ${result}`);
    assert.ok(!result.includes('***'), `Unnecessary masking: ${result}`);
  });

  it('masks user-only auth', () => {
    const result = maskUrlCredentials('redis://admin@localhost:6399');
    assert.ok(!result.includes('admin'), `Leaked username: ${result}`);
    assert.ok(result.includes('***'), `Should have masked: ${result}`);
  });

  it('returns *** for non-URL strings', () => {
    assert.equal(maskUrlCredentials('not-a-url'), '***');
  });
});

describe('buildEnvSummary', () => {
  afterEach(() => restoreEnv());

  it('returns currentValue for set env vars', () => {
    setEnv('API_SERVER_PORT', '4000');
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'API_SERVER_PORT');
    assert.ok(entry);
    assert.equal(entry.currentValue, '4000');
  });

  it('returns null for unset env vars', () => {
    setEnv('FRONTEND_URL', undefined);
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'FRONTEND_URL');
    assert.ok(entry);
    assert.equal(entry.currentValue, null);
  });

  it('masks sensitive env vars with ***', () => {
    setEnv('OPENAI_API_KEY', 'sk-secret-key-12345');
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'OPENAI_API_KEY');
    assert.ok(entry);
    assert.equal(entry.currentValue, '***');
  });

  it('masks REDIS_URL credentials but preserves host', () => {
    setEnv('REDIS_URL', 'redis://user:super-secret@myhost:6399/15');
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'REDIS_URL');
    assert.ok(entry);
    assert.ok(!entry.currentValue.includes('super-secret'), `Leaked password: ${entry.currentValue}`);
    assert.ok(entry.currentValue.includes('myhost:6399'), `Lost host: ${entry.currentValue}`);
  });

  it('returns same number of entries as ENV_VARS', () => {
    const summary = buildEnvSummary();
    assert.ok(summary.length < ENV_VARS.length);
  });

  it('hides per-cat runtime budget env vars from hub summary', () => {
    const summary = buildEnvSummary();
    assert.equal(
      summary.some((v) => v.name === 'CAT_OPUS_MAX_PROMPT_CHARS'),
      false,
    );
    assert.equal(
      summary.some((v) => v.name === 'CAT_CODEX_MAX_PROMPT_CHARS'),
      false,
    );
    assert.equal(
      summary.some((v) => v.name === 'CAT_GEMINI_MAX_PROMPT_CHARS'),
      false,
    );
    assert.equal(
      summary.some((v) => v.name === 'MAX_PROMPT_TOKENS'),
      false,
    );
  });
});

describe('GET /api/config/env-summary (route)', () => {
  it('projectRoot follows CAT_TEMPLATE_PATH directory when set', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-summary-'));
    const templatePath = resolve(tempRoot, 'cat-template.json');
    writeFileSync(templatePath, '{}', 'utf8');
    setEnv('CAT_TEMPLATE_PATH', templatePath);
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      const root = body.paths.projectRoot;
      assert.equal(root, tempRoot);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('dataDirs returns absolute resolved paths from API', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const app = Fastify({ logger: false });
    await configRoutes(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
    const body = JSON.parse(res.payload);
    const { dataDirs } = body.paths;

    assert.ok(dataDirs, 'paths.dataDirs should exist');
    for (const key of ['auditLogs', 'cliArchive', 'redisDevSandbox', 'uploads']) {
      assert.ok(dataDirs[key], `dataDirs.${key} should exist`);
      assert.ok(dataDirs[key].startsWith('/'), `dataDirs.${key} should be absolute, got: ${dataDirs[key]}`);
    }

    await app.close();
  });

  // F212 Phase F (cloud codex R3 P2 on 3083d7c5f + R4 P2-#2 on fc69597675):
  // env-summary.runtimeLogs MUST equal logger's CAPTURED LOG_DIR_PATH — not
  // process.env.LOG_DIR read at request time. Runtime `PATCH /api/config/env` LOG_DIR
  // edit would change process.env but pino destination is already bound to the
  // captured path → users following the AC-F5 hint would grep an empty new directory.
  it('AC-F5 (R3+R4): runtimeLogs equals logger captured LOG_DIR_PATH (single source of truth)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const { LOG_DIR_PATH } = await import('../dist/infrastructure/logger.js');
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      const body = JSON.parse(res.payload);
      assert.equal(
        body.paths.dataDirs.runtimeLogs,
        LOG_DIR_PATH,
        'runtimeLogs MUST equal logger LOG_DIR_PATH (R3+R4 single-source fix)',
      );
      assert.ok(body.paths.dataDirs.runtimeLogs.startsWith('/'), 'absolute path');
    } finally {
      await app.close();
    }
  });

  it('AC-F5 (R4 P2-#2): runtime process.env.LOG_DIR mutation MUST NOT change reported runtimeLogs', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const { LOG_DIR_PATH } = await import('../dist/infrastructure/logger.js');
    // Mutate AFTER logger already captured (simulates runtime PATCH /api/config/env).
    const mutatedPath = mkdtempSync(resolve(tmpdir(), 'cat-cafe-mutated-log-'));
    setEnv('LOG_DIR', mutatedPath);
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      const body = JSON.parse(res.payload);
      assert.equal(
        body.paths.dataDirs.runtimeLogs,
        LOG_DIR_PATH,
        'env-summary ignores runtime mutation — stays on captured logger path',
      );
      assert.notEqual(
        body.paths.dataDirs.runtimeLogs,
        mutatedPath,
        'mutated env value MUST NOT propagate (R4 P2-#2 regression guard)',
      );
    } finally {
      await app.close();
      rmSync(mutatedPath, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/config/env (route)', () => {
  afterEach(() => restoreEnv());

  it('writes runtime-editable env vars back to the configured .env file', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    const auditEvents = [];
    writeFileSync(envFilePath, 'PREVIEW_GATEWAY_PORT=4100\nOPENAI_API_KEY=sk-old\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: {
          append: async (event) => {
            auditEvents.push(event);
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'PREVIEW_GATEWAY_PORT', value: '4200' }],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'PREVIEW_GATEWAY_PORT=4200\nOPENAI_API_KEY=sk-old\n');
      assert.equal(process.env.PREVIEW_GATEWAY_PORT, '4200');
      assert.equal(auditEvents.length, 1);
      assert.equal(auditEvents[0].data.target, '.env');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('escapes shell substitution characters when persisting .env values', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    const literal = 'https://proxy.example/$HOME/$(whoami)/`whoami`';
    writeFileSync(envFilePath, '', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'THEME_CONFIG', value: literal }],
        },
      });

      assert.equal(res.statusCode, 200);
      const persisted = readFileSync(envFilePath, 'utf8');
      assert.match(persisted, /^THEME_CONFIG="https:\/\/proxy\.example\/\\\$HOME\/\\\$\(whoami\)\/\\`whoami\\`"$/m);

      const sourced = execFileSync('sh', ['-lc', `set -a; . "${envFilePath}"; printf '%s' "$THEME_CONFIG"`], {
        encoding: 'utf8',
      }).trim();
      assert.equal(sourced, literal);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('escapes CR/LF characters to avoid multiline env injection', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    const literal = 'line1\r\nline2\nline3';
    writeFileSync(envFilePath, '', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'THEME_CONFIG', value: literal }],
        },
      });

      assert.equal(res.statusCode, 200);
      const persisted = readFileSync(envFilePath, 'utf8');
      assert.match(persisted, /^THEME_CONFIG="line1\\\\r\\\\nline2\\\\nline3"$/m);
      assert.equal(persisted.trimEnd().split('\n').length, 1);

      const sourced = execFileSync('sh', ['-lc', `set -a; . "${envFilePath}"; printf '%s' "$THEME_CONFIG"`], {
        encoding: 'utf8',
      }).trim();
      assert.equal(sourced, 'line1\\r\\nline2\\nline3');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects OPENAI_API_KEY env write since it is no longer runtimeEditable (#340 P6)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'OPENAI_API_KEY', value: 'sk-new' }],
        },
      });

      // #340 P6: OPENAI_API_KEY is no longer runtimeEditable (managed by accounts system)
      assert.equal(res.statusCode, 400);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'OPENAI_API_KEY=sk-old\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects CONNECTOR_GATEWAY_AUTOSTART hub writes because IM autostart is a startup trust boundary', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'CONNECTOR_GATEWAY_AUTOSTART=0\n', 'utf8');
    setEnv('CONNECTOR_GATEWAY_AUTOSTART', '0');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'CONNECTOR_GATEWAY_AUTOSTART', value: '1' }],
        },
      });

      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /not editable/i);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'CONNECTOR_GATEWAY_AUTOSTART=0\n');
      assert.equal(process.env.CONNECTOR_GATEWAY_AUTOSTART, '0');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects client-bundled NEXT_PUBLIC vars from hub writes because the browser reads them at build time', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(
      envFilePath,
      [
        'NEXT_PUBLIC_API_URL=http://localhost:3004',
        'NEXT_PUBLIC_WHISPER_URL=http://localhost:9876',
        'NEXT_PUBLIC_LLM_POSTPROCESS_URL=http://localhost:9878',
        'NEXT_PUBLIC_PROJECT_ROOT=/tmp/project',
        'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI=0',
      ].join('\n') + '\n',
      'utf8',
    );

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const beforeRaw = readFileSync(envFilePath, 'utf8');
      for (const name of BOOTSTRAP_ONLY_NEXT_PUBLIC_VARS) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: {
            updates: [{ name, value: `${name}-changed` }],
          },
        });

        assert.equal(res.statusCode, 400, `${name} should be rejected`);
        const body = JSON.parse(res.payload);
        assert.match(body.error, /not editable/);
        assert.equal(readFileSync(envFilePath, 'utf8'), beforeRaw);
      }
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects internal runtime budget env vars from hub writes', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'CAT_OPUS_MAX_PROMPT_CHARS=150000\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'CAT_OPUS_MAX_PROMPT_CHARS', value: '180000' }],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /not editable/);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'CAT_OPUS_MAX_PROMPT_CHARS=150000\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects API_SERVER_PORT from hub writes but keeps PREVIEW_GATEWAY_PORT editable', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'API_SERVER_PORT=3003\nPREVIEW_GATEWAY_PORT=4100\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const apiPortRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'API_SERVER_PORT', value: '3203' }],
        },
      });
      assert.equal(apiPortRes.statusCode, 400);
      assert.match(JSON.parse(apiPortRes.payload).error, /not editable/i);

      const previewPortRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'PREVIEW_GATEWAY_PORT', value: '4200' }],
        },
      });
      assert.equal(previewPortRes.statusCode, 200);

      const nextEnv = readFileSync(envFilePath, 'utf8');
      assert.match(nextEnv, /API_SERVER_PORT=3003/);
      assert.match(nextEnv, /PREVIEW_GATEWAY_PORT=4200/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects REDIS_URL from hub writes because runtime redis clients are bootstrapped at startup', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'REDIS_URL=redis://localhost:6399/15\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'REDIS_URL', value: 'redis://localhost:6398/15' }],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /not editable/i);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'REDIS_URL=redis://localhost:6399/15\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects filesystem policy and owner trust-anchor writes through the generic env endpoint', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      for (const name of [
        'PROJECT_ALLOWED_ROOTS',
        'PROJECT_ALLOWED_ROOTS_APPEND',
        'PROJECT_DENIED_ROOTS',
        'DEFAULT_OWNER_USER_ID',
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name, value: '/tmp/untrusted' }] },
        });
        assert.equal(response.statusCode, 400, `${name} must be rejected`);
        assert.match(JSON.parse(response.payload).error, /not editable/i);
      }
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects startup-only telemetry vars from hub writes (F153 Phase K regression)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'OTEL_SDK_DISABLED=false\nPROMETHEUS_PORT=9464\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      // Startup-only telemetry var must be rejected
      const otelRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'OTEL_SDK_DISABLED', value: 'true' }],
        },
      });
      assert.equal(otelRes.statusCode, 400, 'OTEL_SDK_DISABLED should be rejected');
      assert.match(JSON.parse(otelRes.payload).error, /not editable/i);

      // BurnRateMonitor caches thresholds at construction — must also be rejected
      const alertRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'TELEMETRY_ALERT_ERROR_RATE', value: '0.5' }],
        },
      });
      assert.equal(alertRes.statusCode, 400, 'TELEMETRY_ALERT_ERROR_RATE should be rejected (startup-only)');

      // Verify .env file unchanged for startup-only var
      const envContent = readFileSync(envFilePath, 'utf8');
      assert.match(envContent, /OTEL_SDK_DISABLED=false/, 'startup-only var must not be written');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('#770: read-only-opt-in sensitive vars still require owner/session gate', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, ['GITHUB_WEBHOOK_SECRET=whsec_old', 'F102_API_KEY=old-key'].join('\n') + '\n', 'utf8');

    function addSessionHook(app) {
      app.addHook('preHandler', async (request) => {
        const sessionUser = request.headers['x-test-session-user'];
        if (typeof sessionUser === 'string' && sessionUser.trim()) {
          request.sessionUserId = sessionUser.trim();
        }
      });
    }

    const app = Fastify({ logger: false });
    addSessionHook(app);
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const beforeRaw = readFileSync(envFilePath, 'utf8');
      // Only the sensitive read-only-opt-in vars are gated by the existing
      // owner/session check; non-sensitive ones are freely runtime-editable.
      for (const name of ['GITHUB_WEBHOOK_SECRET', 'F102_API_KEY']) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name, value: `${name}-changed` }] },
        });
        assert.equal(res.statusCode, 401, `${name} should require session auth`);
        assert.match(JSON.parse(res.payload).error, /session authentication/);
        assert.equal(readFileSync(envFilePath, 'utf8'), beforeRaw, `${name} must not mutate .env`);
      }
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────
// #770 System Settings tests
// ────────────────────────────────────────────────────

describe('#770: isEditableEnvVar fail-closed default', () => {
  it('vars without runtimeEditable declaration are not editable', () => {
    // Find vars that have no runtimeEditable field at all
    const undeclared = ENV_VARS.filter((v) => v.runtimeEditable === undefined);
    assert.ok(undeclared.length > 0, 'should have vars without runtimeEditable');
    for (const def of undeclared) {
      assert.equal(isEditableEnvVar(def), false, `${def.name} has no runtimeEditable — fail-closed should reject`);
    }
  });

  it('only explicit runtimeEditable: true passes', () => {
    const editable = ENV_VARS.filter((v) => isEditableEnvVar(v));
    for (const def of editable) {
      assert.equal(
        def.runtimeEditable,
        true,
        `${def.name} passes isEditableEnvVar but runtimeEditable is ${def.runtimeEditable}`,
      );
    }
  });
});

describe('#770: SYSTEM_VARS and buildSystemEnvSummary', () => {
  afterEach(() => restoreEnv());

  it('SYSTEM_VARS contains exactly 25 curated variables', () => {
    assert.equal(SYSTEM_VARS.size, 25);
  });

  it('every SYSTEM_VAR exists in the registry', () => {
    const registryNames = new Set(ENV_VARS.map((v) => v.name));
    for (const name of SYSTEM_VARS) {
      assert.ok(registryNames.has(name), `${name} is in SYSTEM_VARS but not in ENV_VARS`);
    }
  });

  it('every SYSTEM_VAR has a settingsGroup', () => {
    for (const name of SYSTEM_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def.settingsGroup, `${name} should have a settingsGroup`);
    }
  });

  it('every SYSTEM_VAR has explicit runtimeEditable (boolean, not undefined)', () => {
    for (const name of SYSTEM_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.equal(
        typeof def.runtimeEditable,
        'boolean',
        `${name} must have explicit runtimeEditable (got ${def.runtimeEditable})`,
      );
    }
  });

  it('every SYSTEM_VAR has a label', () => {
    for (const name of SYSTEM_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def.label, `${name} should have a label`);
    }
  });

  it('security SYSTEM_VARS are explicitly runtimeEditable: false', () => {
    for (const name of [
      'PROJECT_ALLOWED_ROOTS',
      'PROJECT_ALLOWED_ROOTS_APPEND',
      'PROJECT_DENIED_ROOTS',
      'DEFAULT_OWNER_USER_ID',
    ]) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, false, `${name} must not be editable`);
      assert.equal(def.settingsGroup, 'security');
    }
  });

  it('buildSystemEnvSummary returns only SYSTEM_VARS entries', () => {
    const summary = buildSystemEnvSummary();
    assert.equal(summary.length, SYSTEM_VARS.size);
    for (const entry of summary) {
      assert.ok(SYSTEM_VARS.has(entry.name), `${entry.name} should be in SYSTEM_VARS`);
    }
  });

  it('buildSystemEnvSummary includes metadata fields', () => {
    const summary = buildSystemEnvSummary();
    for (const entry of summary) {
      assert.ok(entry.label, `${entry.name} should have label`);
      assert.ok(entry.settingsGroup, `${entry.name} should have settingsGroup`);
    }
  });

  it('buildSystemEnvSummary excludes deprecated vars (system-path defense)', () => {
    // Temporarily mark a real SYSTEM_VAR deprecated to exercise the filter branch.
    const def = ENV_VARS.find((v) => v.name === 'PREVIEW_GATEWAY_PORT');
    assert.ok(def, 'PREVIEW_GATEWAY_PORT exists in registry');
    const originalDeprecated = def.deprecated;
    def.deprecated = 'synthetic test marker';
    try {
      const summary = buildSystemEnvSummary();
      const names = summary.map((e) => e.name);
      assert.ok(!names.includes('PREVIEW_GATEWAY_PORT'), 'deprecated SYSTEM_VAR must be excluded from system summary');
      for (const entry of summary) {
        assert.ok(!entry.deprecated, `${entry.name} is deprecated and must not appear in System summary`);
      }
    } finally {
      if (originalDeprecated === undefined) {
        delete def.deprecated;
      } else {
        def.deprecated = originalDeprecated;
      }
    }
  });
});

describe('#770: deprecated metadata (dead-config marking)', () => {
  // Vars whose runtime consumers were removed — verified by repo-wide reference
  // scan including shell scripts and skills:
  //   - MODE_SWITCH_REQUIRES_APPROVAL: Mode-system consumer (ModeOrchestrator) was
  //     removed in the F101 Mode v2 rework (2dfece987), before the TD117 registry
  //     backfill (b58106d0d) re-registered the then-already-dead var
  //   - GITHUB_REVIEW_IMAP_* + POLL_INTERVAL: IMAP mail-poll channel removed in v0.9.0 sync (#596);
  //     PR review feedback now flows through register_pr_tracking-driven GitHub API polling
  //     (GITHUB_WEBHOOK_SECRET belongs to the separate Repo Inbox webhook, not this channel)
  const DEAD_VARS = [
    'MODE_SWITCH_REQUIRES_APPROVAL',
    'GITHUB_REVIEW_IMAP_USER',
    'GITHUB_REVIEW_IMAP_PASS',
    'GITHUB_REVIEW_IMAP_HOST',
    'GITHUB_REVIEW_IMAP_PORT',
    'GITHUB_REVIEW_POLL_INTERVAL_MS',
    'GITHUB_REVIEW_IMAP_PROXY',
  ];

  it('every known dead-config var stays in the registry (canonical truth — no deletion)', () => {
    const registryNames = new Set(ENV_VARS.map((v) => v.name));
    for (const name of DEAD_VARS) {
      assert.ok(registryNames.has(name), `${name} must remain registered (registry entries are never deleted)`);
    }
  });

  it('every known dead-config var carries a non-empty deprecated reason', () => {
    for (const name of DEAD_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(typeof def.deprecated, 'string', `${name} must have a deprecated reason string`);
      assert.ok(def.deprecated.length > 0, `${name} deprecated reason must be non-empty`);
    }
  });

  it('deprecated vars are never runtimeEditable', () => {
    for (const def of ENV_VARS) {
      if (def.deprecated) {
        assert.notEqual(def.runtimeEditable, true, `${def.name} is deprecated and must not be editable`);
      }
    }
  });

  it('deprecated vars never appear in the SYSTEM_VARS curated projection', () => {
    for (const def of ENV_VARS) {
      if (def.deprecated) {
        assert.ok(!SYSTEM_VARS.has(def.name), `${def.name} is deprecated and must not be a curated System var`);
      }
    }
  });

  it('buildEnvSummary carries deprecated through to the API payload', () => {
    const summary = buildEnvSummary();
    for (const name of DEAD_VARS) {
      const entry = summary.find((v) => v.name === name);
      if (!entry) continue; // hubVisible:false vars are excluded from the summary by design
      assert.equal(typeof entry.deprecated, 'string', `${name} summary entry must expose deprecated`);
    }
    // At least one deprecated var must actually reach the payload, otherwise the
    // frontend "已废弃" badge (EnvSubComponents) has nothing to render.
    assert.ok(
      summary.some((v) => typeof v.deprecated === 'string' && v.deprecated.length > 0),
      'at least one deprecated var must be visible in the env summary',
    );
  });
});

describe('#770: DEFAULT_OWNER_USER_ID trust-anchor projection', () => {
  it('DEFAULT_OWNER_USER_ID is a curated System var (issue #770 allowlist)', () => {
    assert.ok(SYSTEM_VARS.has('DEFAULT_OWNER_USER_ID'));
  });

  it('DEFAULT_OWNER_USER_ID projection is read-only with restart-required semantics', () => {
    const def = ENV_VARS.find((v) => v.name === 'DEFAULT_OWNER_USER_ID');
    assert.ok(def, 'DEFAULT_OWNER_USER_ID should be in registry');
    // Trust anchor: the owner gate derives ALL identity checks from this value.
    // Allowing runtime edits would let a session grant itself ownership
    // (privilege bootstrap paradox) — must stay editable only via .env + restart.
    assert.equal(def.runtimeEditable, false);
    assert.equal(def.restartRequired, true);
    assert.equal(def.settingsGroup, 'security');
    assert.ok(def.label, 'needs a human-friendly label for the System page');
    assert.ok(
      def.description.includes('单用户'),
      'description must explain the unset ⇒ single-user-mode semantics so the read-only value is interpretable',
    );
  });
});

describe('#770: SETTINGS_GROUPS', () => {
  it('has exactly 5 groups', () => {
    const keys = Object.keys(SETTINGS_GROUPS);
    assert.equal(keys.length, 5);
  });

  it('contains network, storage, lifecycle, runtime, security', () => {
    for (const key of ['network', 'storage', 'lifecycle', 'runtime', 'security']) {
      assert.ok(key in SETTINGS_GROUPS, `SETTINGS_GROUPS should have ${key}`);
      assert.ok(typeof SETTINGS_GROUPS[key] === 'string', `SETTINGS_GROUPS.${key} should be a string label`);
    }
  });
});

describe('#770: parseBoolEnv', () => {
  it('parses "1" as true', () => {
    assert.equal(parseBoolEnv('1'), true);
  });
  it('parses "true" as true (case-insensitive)', () => {
    assert.equal(parseBoolEnv('true'), true);
    assert.equal(parseBoolEnv('TRUE'), true);
    assert.equal(parseBoolEnv('True'), true);
  });
  it('parses "0" as false', () => {
    assert.equal(parseBoolEnv('0'), false);
  });
  it('parses undefined with default', () => {
    assert.equal(parseBoolEnv(undefined), false);
    assert.equal(parseBoolEnv(undefined, true), true);
  });
  it('parses other strings as false', () => {
    assert.equal(parseBoolEnv('false'), false);
    assert.equal(parseBoolEnv('no'), false);
    assert.equal(parseBoolEnv(''), false);
  });
});

describe('#770: GET /api/config/env-summary?surface=system', () => {
  afterEach(() => restoreEnv());

  it('returns only SYSTEM_VARS with groups when surface=system', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/config/env-summary?surface=system',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);

      assert.ok(body.groups, 'response should have groups');
      assert.ok(body.variables, 'response should have variables');
      assert.equal(body.variables.length, SYSTEM_VARS.size);

      // Every variable should be a known SYSTEM_VAR
      for (const v of body.variables) {
        assert.ok(SYSTEM_VARS.has(v.name), `${v.name} should be in SYSTEM_VARS`);
      }

      // Should NOT have paths/categories (those are full-summary only)
      assert.equal(body.paths, undefined, 'system surface should not include paths');
      assert.equal(body.categories, undefined, 'system surface should not include categories');
    } finally {
      await app.close();
    }
  });

  it('full summary (no surface param) still works unchanged', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/config/env-summary',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.categories, 'full summary should have categories');
      assert.ok(body.paths, 'full summary should have paths');
      assert.ok(body.variables.length > SYSTEM_VARS.size, 'full summary should have more vars');
    } finally {
      await app.close();
    }
  });
});

describe('#770 PR-A: section projection + control metadata', () => {
  it('SECTION_PROJECTION.system is exactly SYSTEM_VARS', () => {
    assert.deepEqual(
      new Set(SECTION_PROJECTION.system),
      SYSTEM_VARS,
      'system projection must stay identical to SYSTEM_VARS',
    );
  });

  it('exposes all known section keys with labels', () => {
    assert.ok(ENV_SECTION_KEYS.length >= 8, 'should have system + 7 module sections');
    for (const key of ENV_SECTION_KEYS) {
      assert.ok(SECTION_PROJECTION[key], `SECTION_PROJECTION.${key} should exist`);
    }
  });

  it('fail-closed: unknown section returns empty summary', () => {
    const summary = buildSectionEnvSummary('nonexistent');
    assert.deepEqual(summary, []);
  });

  it('buildSectionEnvSummary returns only projected vars for a module section', () => {
    // PR-A intentionally ships with empty module projections while the
    // per-module UI ownership is re-audited; infrastructure stays, content is
    // added back in PR-C.
    const voice = buildSectionEnvSummary('voice');
    assert.equal(voice.length, 0, 'voice section projection is empty in PR-A');
    assert.ok(!voice.some((v) => v.name === 'API_SERVER_PORT'), 'voice section should not include system vars');
  });

  it('hubVisible:false vars are excluded from section summaries', () => {
    const members = buildSectionEnvSummary('members');
    const names = new Set(members.map((v) => v.name));
    assert.ok(!names.has('GOOGLE_API_KEY'), 'GOOGLE_API_KEY is hubVisible:false and should be hidden');
  });

  it('getEnvVarSections reports section membership', () => {
    // PR-A: module projections are empty, so non-system vars have no curated
    // section until PR-C re-adds them with UI-owner sign-off.
    assert.deepEqual(getEnvVarSections('TTS_URL'), []);
    assert.deepEqual(getEnvVarSections('CAT_CAFE_USER_ID'), []);
    assert.deepEqual(getEnvVarSections('API_SERVER_PORT'), ['system']);
  });

  it('LOG_LEVEL allowedValues match Pino LevelWithSilent', () => {
    const def = ENV_VARS.find((v) => v.name === 'LOG_LEVEL');
    assert.ok(def, 'LOG_LEVEL should be registered');
    assert.deepEqual(
      def.allowedValues,
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      'must align with pino.LevelWithSilent consumed by infrastructure/logger.ts',
    );
    assert.equal(inferEnvControl(def), 'dropdown');
  });

  it('inferEnvControl maps booleanSemantics to toggle', () => {
    const cors = ENV_VARS.find((v) => v.name === 'CORS_ALLOW_PRIVATE_NETWORK');
    assert.equal(inferEnvControl(cors), 'toggle');
  });

  it('inferEnvControl respects explicit control metadata', () => {
    const dataDir = ENV_VARS.find((v) => v.name === 'DATA_DIR');
    assert.equal(inferEnvControl(dataDir), 'dirpicker');
  });

  it('inferEnvControl defaults plain text vars to text', () => {
    const apiPort = ENV_VARS.find((v) => v.name === 'API_SERVER_PORT');
    assert.equal(inferEnvControl(apiPort), 'text');
  });

  it('marks directory-type vars with control: dirpicker', () => {
    const DIR_VARS = [
      'DATA_DIR',
      'CACHE_DIR',
      'CAT_CAFE_DATA_DIR',
      'LOG_DIR',
      'GENSHIN_VOICE_DIR',
      'CHARACTER_VOICE_DIR',
      'TRANSCRIPT_DIR',
      'SIGNALS_ROOT_DIR',
      'CAT_CAFE_CALLBACK_OUTBOX_DIR',
    ];
    for (const name of DIR_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be registered`);
      assert.equal(def.control, 'dirpicker', `${name} should be marked as dirpicker`);
    }
  });

  it('does not mark file paths as dirpicker', () => {
    const FILE_VARS = ['CHROME_EXECUTABLE_PATH', 'KIMI_CONFIG_FILE', 'CAT_TEMPLATE_PATH', 'LISTEN_MODE_DB'];
    for (const name of FILE_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be registered`);
      assert.notEqual(def.control, 'dirpicker', `${name} is a file path, not a directory`);
    }
  });

  it('does not mark multi-path list vars as dirpicker', () => {
    // PROJECT_ALLOWED_ROOTS / PROJECT_DENIED_ROOTS are split by project-path.ts
    // on node:path delimiter into a LIST of roots (e.g. /opt/a:/opt/b). A single
    // -directory picker would silently drop the list semantics (codex/sol #1344
    // P2). They render as multi-path text; a real multi-dir control is out of
    // scope for PR-A (do not extend the control protocol here).
    const MULTI_PATH_VARS = ['PROJECT_ALLOWED_ROOTS', 'PROJECT_DENIED_ROOTS'];
    for (const name of MULTI_PATH_VARS) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be registered`);
      assert.notEqual(def.control, 'dirpicker', `${name} is a multi-path list, not a single directory`);
      assert.equal(inferEnvControl(def), 'text', `${name} must render as multi-path text`);
    }
  });

  it('inventory doc stays in sync with the live registry (set + control types)', () => {
    // #770 PR-A: docs/plans/770-env-config-inventory.md is the audit baseline for
    // the follow-up B/C/D/E slices, so it must not drift from the registry after a
    // rebase. Parse the inventory tables and enforce two invariants:
    //   1. the documented var set is exactly ENV_VARS (no missing / no stale);
    //   2. each row's "control type" column equals inferEnvControl(def).
    const inventoryPath = fileURLToPath(new URL('../../../docs/plans/770-env-config-inventory.md', import.meta.url));
    const rows = [];
    for (const line of readFileSync(inventoryPath, 'utf8').split('\n')) {
      if (!line.startsWith('|')) continue;
      const cols = line.split('|').map((c) => c.trim());
      const name = cols[2];
      if (!name || name === 'var name' || name.startsWith('---')) continue;
      rows.push({ name, control: cols[7] });
    }
    const registryNames = new Set(ENV_VARS.map((v) => v.name));
    const docNames = new Set(rows.map((r) => r.name));
    const missing = [...registryNames].filter((n) => !docNames.has(n)).sort();
    const stale = [...docNames].filter((n) => !registryNames.has(n)).sort();
    assert.deepEqual(missing, [], `inventory is missing registry vars: ${missing.join(', ')}`);
    assert.deepEqual(stale, [], `inventory lists vars no longer in registry: ${stale.join(', ')}`);
    assert.equal(rows.length, ENV_VARS.length, 'inventory must have exactly one row per registry var');
    const byName = new Map(ENV_VARS.map((v) => [v.name, v]));
    const controlDrift = rows
      .filter((r) => byName.has(r.name) && r.control !== inferEnvControl(byName.get(r.name)))
      .map((r) => `${r.name}: doc=${r.control} vs registry=${inferEnvControl(byName.get(r.name))}`);
    assert.deepEqual(controlDrift, [], `inventory control-type drift:\n${controlDrift.join('\n')}`);
  });

  it('every module projection target exists in ENV_VARS', () => {
    const registryNames = new Set(ENV_VARS.map((v) => v.name));
    for (const section of Object.keys(MODULE_SECTION_PROJECTION)) {
      for (const name of MODULE_SECTION_PROJECTION[section]) {
        assert.ok(registryNames.has(name), `${name} in section ${section} must be registered`);
      }
    }
  });

  it('module sections never repeat system vars', () => {
    for (const section of Object.keys(MODULE_SECTION_PROJECTION)) {
      for (const name of MODULE_SECTION_PROJECTION[section]) {
        assert.ok(!SYSTEM_VARS.has(name), `${name} must not appear in both system and section ${section}`);
      }
    }
  });

  it('every section key has a label', () => {
    for (const key of ENV_SECTION_KEYS) {
      assert.ok(ENV_SECTION_LABELS[key], `section ${key} must have a label`);
    }
  });

  it('deprecated vars are excluded from section summaries', () => {
    const fakeSummary = [
      { name: 'TTS_URL', currentValue: 'http://tts', deprecated: 'removed', hubVisible: true },
      { name: 'WHISPER_URL', currentValue: 'http://whisper', deprecated: undefined, hubVisible: true },
    ];
    const allowed = new Set(['TTS_URL', 'WHISPER_URL']);
    const voice = filterEnvSummaryForSection(allowed, fakeSummary);
    const names = voice.map((v) => v.name);
    assert.ok(!names.includes('TTS_URL'), 'deprecated var should be filtered out');
    assert.ok(names.includes('WHISPER_URL'), 'non-deprecated var should remain');
  });

  it('targetWritePolicy read-only-opt-in vars stay API-editable but UI-hidden by default', () => {
    const OPT_IN_READONLY = [
      'WEIXIN_VOICE_ITEM_MODE',
      'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
      'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_SELF_LOGIN',
      'F102_API_KEY',
    ];
    for (const name of OPT_IN_READONLY) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.targetWritePolicy, 'read-only-opt-in');
      assert.equal(def.runtimeEditable, true, `${name} runtimeEditable stays true for backward compat`);
      // API layer stays editable so the owner/session gate (not the registry)
      // remains the authority for sensitive writes. The generic Hub UI hides
      // these editors via isEditableVariable in EnvSubComponents.tsx.
      assert.equal(isEditableEnvVar(def), true, `${name} must remain API-editable`);
      assert.equal(isEditableEnvVarName(name), true, `${name} must remain editable by name`);
    }
  });

  it('MODULE_SECTION_PROJECTION is intentionally empty in PR-A', () => {
    // PR-A lands the section/filter/write-policy infrastructure without a
    // module projection allowlist. The previous 42-var projection was retracted
    // after an ownership audit showed most entries already have dedicated UI
    // coverage, are internal/deploy-only, or need component-level extensions
    // rather than a generic env card. PR-C will re-add sets per module owner.
    for (const section of Object.keys(MODULE_SECTION_PROJECTION)) {
      assert.equal(MODULE_SECTION_PROJECTION[section].size, 0, `${section} projection must be empty until PR-C`);
    }
  });

  it('ENV_SECTION_KEYS is the exact locked set of sections', () => {
    assert.deepEqual(
      new Set(ENV_SECTION_KEYS),
      new Set(['system', 'im', 'voice', 'notify', 'ops', 'accounts', 'members', 'plugins']),
    );
  });
});
