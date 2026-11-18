import { join } from 'node:path';

/** Complete storage coordinates for this live test; ambient runtime state is not inherited. */
export function acceptanceEnvironment(ambient, workspace, root) {
  const env = { ...ambient };
  for (const key of Object.keys(env).filter((key) =>
    /^(CAT_CAFE_|CAT_TEMPLATE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|REDIS_|MEMORY_STORE|EVIDENCE_DB|EVENT_MEMORY_DB|LISTEN_MODE_DB|TTS_CACHE_DIR)/.test(
      key,
    ),
  ))
    delete env[key];
  const home = join(root, 'home');
  const config = join(root, 'config');
  const data = join(root, 'data');
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'),
    CODEX_SQLITE_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CAT_CAFE_CONFIG_ROOT: config,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: config,
    CAT_CAFE_DATA_DIR: data,
    CAT_TEMPLATE_PATH: join(config, 'cat-template.json'),
    EVIDENCE_DB: join(data, 'evidence.sqlite'),
    EVENT_MEMORY_DB: join(data, 'event-memory.sqlite'),
    LISTEN_MODE_DB: join(data, 'listen-mode.sqlite'),
    TTS_CACHE_DIR: join(data, 'tts'),
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    CAT_CAFE_PROVISION_GLOBAL_SIDECAR: '0',
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    NODE_ENV: 'development',
    API_SERVER_HOST: '127.0.0.1',
    API_SERVER_PORT: '3219',
    FRONTEND_PORT: '5220',
    REDIS_URL: 'redis://127.0.0.1:6427/0',
    REDIS_PORT: '6427',
    PREVIEW_GATEWAY_PORT: '4117',
    PROMETHEUS_PORT: '9467',
    ASR_ENABLED: 'false',
    TTS_ENABLED: 'false',
    EMBED_ENABLED: 'false',
    LLM_POSTPROCESS_ENABLED: 'false',
    MESSAGE_TTL_SECONDS: '0',
    THREAD_TTL_SECONDS: '0',
    TASK_TTL_SECONDS: '0',
    ALLOWED_WORKSPACE_DIRS: root,
  });
}
