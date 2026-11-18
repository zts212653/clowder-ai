import assert from 'node:assert/strict';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { acceptanceEnvironment } from './superagent-acceptance-env.mjs';

test('live Host ignores inherited production SQLite, Redis, configuration and native history coordinates', () => {
  const root = resolve('artifacts/superagent-live');
  const ambient = Object.fromEntries(
    [
      'EVIDENCE_DB',
      'EVENT_MEMORY_DB',
      'LISTEN_MODE_DB',
      'TTS_CACHE_DIR',
      'REDIS_URL',
      'CAT_CAFE_DATA_DIR',
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_TEMPLATE_PATH',
      'HOME',
      'USERPROFILE',
      'CODEX_HOME',
      'CODEX_SQLITE_HOME',
      'CLAUDE_CONFIG_DIR',
    ].map((key) => [key, '/protected/runtime/state']),
  );
  const env = acceptanceEnvironment(ambient, process.cwd(), root);
  for (const key of Object.keys(ambient).filter((key) => key !== 'REDIS_URL')) {
    assert.ok(!relative(root, env[key]).startsWith('..'), `${key} must belong to the acceptance directory`);
  }
  assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6427/0');
  assert.equal(ambient.EVIDENCE_DB, '/protected/runtime/state', 'parent runtime configuration stays unchanged');
});
