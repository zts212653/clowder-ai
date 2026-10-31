import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { parse } from 'smol-toml';

// Pinned 0.159.0 alternative authentication/transport inputs; never real credentials.
export const ALTERNATIVE_CODEX_AUTH_INPUTS = [
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
];

export function installAmbientCodexAccount(t) {
  const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f320-account-data-')));
  process.env.CAT_CAFE_DATA_DIR = dataRoot;
  t.after(() => {
    if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const keys = [
    ...ALTERNATIVE_CODEX_AUTH_INPUTS,
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE',
    'OPENAI_ORG_ID',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
    'F320_MCP_TOKEN',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'ambient-account-a-fixture';
  process.env.F320_MCP_TOKEN = 'unrelated-mcp-fixture';
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

export function assertSelectedApiAccount(childEnv, selectedKey, selectedRouting = {}) {
  assert.ok(childEnv.CODEX_HOME.startsWith(`${join(process.env.CAT_CAFE_DATA_DIR, 'codex-api-execution')}${sep}`));
  for (const key of ALTERNATIVE_CODEX_AUTH_INPUTS)
    assert.equal(childEnv[key], undefined, `${key} must not select ambient account A`);
  assert.equal(childEnv.OPENAI_API_KEY, selectedKey);
  for (const key of ['OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'OPENAI_ORG_ID', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'])
    assert.equal(childEnv[key], selectedRouting[key], `${key} must come from the selected account only`);
  assert.equal(childEnv.F320_MCP_TOKEN, 'unrelated-mcp-fixture');
  const childPath = Object.entries(childEnv).find(([key]) => key.toLowerCase() === 'path')?.[1];
  assert.ok(
    childPath?.endsWith(process.env.PATH ?? process.env.Path ?? ''),
    'runtime search path is retained after the existing guard prefix',
  );
}

export function assertSelectedApiProvider(launch, baseUrl) {
  const config = new Map();
  for (let i = 0; i < launch.args.length; i++) {
    if (launch.args[i] !== '--config' && launch.args[i] !== '-c') continue;
    const expression = launch.args[++i];
    const equal = expression.indexOf('=');
    config.set(expression.slice(0, equal), parse(`value=${expression.slice(equal + 1)}`).value);
  }
  assert.equal(config.get('model_provider'), 'custom', 'API identity must use its explicit env_key provider');
  assert.equal(config.get('model_providers.custom.env_key'), 'OPENAI_API_KEY');
  assert.equal(config.get('model_providers.custom.base_url'), baseUrl);
  assert.deepEqual(config.get('model_providers.custom.env_http_headers'), {
    'OpenAI-Organization': 'OPENAI_ORGANIZATION',
    'OpenAI-Project': 'OPENAI_PROJECT',
  });
}
