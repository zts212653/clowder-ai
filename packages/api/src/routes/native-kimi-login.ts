import { homedir } from 'node:os';

const KEYS = ['HOME', 'USERPROFILE', 'KIMI_CODE_HOME'] as const;
const powershell = (value: string) => `'${value.replaceAll("'", "''")}'`;
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Guidance only: never launches login or reads credentials. Bind the same native HOME as this API. */
export function nativeKimiLoginCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const values = {
    HOME: env.HOME ?? homedir(),
    USERPROFILE: env.USERPROFILE ?? homedir(),
    KIMI_CODE_HOME: env.KIMI_CODE_HOME,
  };
  if (platform !== 'win32') {
    const unset = KEYS.filter((key) => values[key] === undefined).map((key) => `-u ${key}`);
    const set = KEYS.flatMap((key) => (values[key] === undefined ? [] : [`${key}=${shell(values[key])}`]));
    return ['env', ...unset, ...set, shell(command), 'login'].join(' ');
  }
  return [
    '& {',
    `  $clowderKimiNames = @(${KEYS.map(powershell).join(', ')})`,
    '  $clowderKimiPrevious = @{}',
    "  foreach ($name in $clowderKimiNames) { $clowderKimiPrevious[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }",
    '  try {',
    ...KEYS.map(
      (key) =>
        `    [Environment]::SetEnvironmentVariable('${key}', ${values[key] === undefined ? '$null' : powershell(values[key])}, 'Process')`,
    ),
    `    & ${powershell(command)} login`,
    '  } finally {',
    "    foreach ($name in $clowderKimiNames) { [Environment]::SetEnvironmentVariable($name, $clowderKimiPrevious[$name], 'Process') }",
    '  }',
    '}',
  ].join('\n');
}
