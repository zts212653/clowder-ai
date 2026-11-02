import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { readCodexLaunchProjection } from '../config/codex-launch-config.js';

export function nativeMetadata(path: string, toml = false): Record<string, unknown> {
  try {
    const source = readFileSync(path, 'utf8');
    const parsed: unknown = toml ? parse(source) : JSON.parse(source);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Follow the same trusted layer order used by native launch inspection. */
export function nativeCodexDefaults(home: string, cwd: string) {
  let projection: ReturnType<typeof readCodexLaunchProjection>;
  try {
    projection = readCodexLaunchProjection(home, cwd);
  } catch {
    return {};
  }
  return projection.layers.reduce<Record<string, unknown>>((current, layer) => {
    if (layer.source === 'argv') return current;
    const [file, profile] = layer.source.split('#profiles.');
    const raw = nativeMetadata(file, true);
    const selected = profile
      ? ((raw.profiles as Record<string, Record<string, unknown>> | undefined)?.[profile] ?? {})
      : raw;
    return {
      ...current,
      ...Object.fromEntries(
        ['model', 'model_reasoning_effort'].filter((key) => key in selected).map((key) => [key, selected[key]]),
      ),
    };
  }, {});
}

export function nativeClaudeDefaults(home: string, cwd: string) {
  return [
    join(home, 'settings.json'),
    join(cwd, '.claude/settings.json'),
    join(cwd, '.claude/settings.local.json'),
  ].reduce<Record<string, unknown>>((current, file) => ({ ...current, ...nativeMetadata(file) }), {});
}

/** Cache validity follows native configuration, not the saved member catalog. */
export function nativeConfigurationRevision(cwd: string) {
  const home = homedir(),
    dsh = process.env.DSH_HOME || join(home, '.dsh');
  const profiles = join(dsh, 'profiles');
  let profileFiles: string[] = [];
  try {
    profileFiles = readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((profile) =>
        ['package.json', 'cordis.yml', 'cordis.patch.yml'].map((file) => join(profiles, profile.name, file)),
      );
  } catch {
    /* Another client's missing or unreadable layout does not invalidate this catalog. */
  }
  const files = [
    join(dsh, 'cordis.patch.yml'),
    join(dsh, '.credentials.yaml'),
    join(dsh, '.env'),
    join(process.env.PI_CODING_AGENT_DIR || join(home, '.pi/agent'), 'settings.json'),
    join(process.env.PI_CODING_AGENT_DIR || join(home, '.pi/agent'), 'models.json'),
    join(process.env.PI_CODING_AGENT_DIR || join(home, '.pi/agent'), 'auth.json'),
    join(process.env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'config.toml'),
    join(cwd, '.codex/config.toml'),
    ...profileFiles,
  ];
  return files.map((file) => {
    try {
      const info = statSync(file);
      return [file, info.mtimeMs, info.size];
    } catch {
      return [file, null];
    }
  });
}
