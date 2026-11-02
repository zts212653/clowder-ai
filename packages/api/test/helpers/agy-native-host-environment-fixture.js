import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgyNativeLaunch } from '../../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import { buildChildEnv } from '../../dist/utils/cli-spawn.js';

export async function nativeHostEnvironmentFixture(t, overrides = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), 'agy-host-tools-'));
  const host = join(root, 'host');
  const workspace = join(root, 'workspace');
  mkdirSync(join(host, '.config', 'git'), { recursive: true });
  mkdirSync(join(host, '.config', 'gh'));
  mkdirSync(workspace);
  const defaults = {
    HOME: host,
    USERPROFILE: host,
    ZDOTDIR: host,
    CAT_CAFE_ORIGINAL_ZDOTDIR: host,
    XDG_CONFIG_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    XDG_DATA_HOME: undefined,
    XDG_STATE_HOME: undefined,
    GH_CONFIG_DIR: undefined,
    GIT_CONFIG_GLOBAL: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const values = { ...defaults, ...overrides({ root, host, workspace }) };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  let plan;
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    plan = await prepareAgyNativeLaunch({
      catId: 'gemini38',
      model: 'gemini-3.8-flash-high',
      command: '/usr/bin/true',
      workspace,
      prompt: 'Synthetic environment fixture; no provider is launched.',
      body: '# Fixture identity',
      profileConfig: {
        enabled: true,
        profileId: 'account-a',
        homeRoot: join(root, 'profiles'),
        model: 'gemini-3.8-flash-high',
        trustedWorkspaces: [workspace],
      },
      options: { spawnCliOverride: async function* () {} },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    t.after(async () => {
      await plan?.disposeCredentials?.();
      rmSync(root, { recursive: true, force: true });
    });
  }
  const env = buildChildEnv(plan.cliOptions.env, {
    inheritParentEnv: plan.cliOptions.inheritParentEnv,
    workingDirectory: workspace,
  });
  // This synthetic fixture never queries operator/system credentials, including on RED.
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  const git = (...args) =>
    spawnSync(
      existsSync('/bin/zsh') ? '/bin/zsh' : 'git',
      existsSync('/bin/zsh') ? ['-c', 'exec git "$@"', 'fixture', ...args] : args,
      { cwd: workspace, env, encoding: 'utf8', timeout: 3000 },
    );
  return { root, host, workspace, plan, env, git };
}
