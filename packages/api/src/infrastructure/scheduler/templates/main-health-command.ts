const HEALTH_SCRIPT_NAME = /^(?:check|test|lint|typecheck|health|verify)(?:[:._-][A-Za-z0-9@/._-]+)*$/;
const HEALTH_TARGET_NAME = /^(?:check|test|lint|typecheck|health|verify)(?:[:._-][A-Za-z0-9@_-]+)*$/;

interface ArgumentGrammar {
  allowed: readonly string[];
  required?: readonly string[];
  anyOf?: readonly string[];
}

const DIRECT_HEALTH_GRAMMARS = new Map<string, ArgumentGrammar>([
  ['tsc', { allowed: ['--noEmit'], required: ['--noEmit'] }],
  ['eslint', { allowed: ['.', '--quiet', '--no-error-on-unmatched-pattern'], required: ['.'] }],
  ['prettier', { allowed: ['.', '--check'], required: ['.', '--check'] }],
  [
    'pytest',
    { allowed: ['-q', '--quiet', '-x', '--exitfirst', '--strict-markers', '--strict-config', '--disable-warnings'] },
  ],
  ['jest', { allowed: ['--ci', '--runInBand', '--passWithNoTests'] }],
  ['vitest', { allowed: ['run', '--run', '--passWithNoTests'], anyOf: ['run', '--run'] }],
]);
const SUBCOMMAND_HEALTH_GRAMMARS = new Map<string, ReadonlyMap<string, ArgumentGrammar>>([
  [
    'biome',
    new Map([
      ['check', { allowed: ['.', '--no-errors-on-unmatched'] }],
      ['lint', { allowed: ['.', '--no-errors-on-unmatched'] }],
    ]),
  ],
  [
    'cargo',
    new Map([
      [
        'check',
        {
          allowed: [
            '--workspace',
            '--all',
            '--all-targets',
            '--all-features',
            '--locked',
            '--offline',
            '-q',
            '--quiet',
          ],
        },
      ],
      [
        'test',
        {
          allowed: [
            '--workspace',
            '--all',
            '--all-targets',
            '--all-features',
            '--locked',
            '--offline',
            '-q',
            '--quiet',
          ],
        },
      ],
      [
        'clippy',
        {
          allowed: [
            '--workspace',
            '--all',
            '--all-targets',
            '--all-features',
            '--locked',
            '--offline',
            '-q',
            '--quiet',
          ],
        },
      ],
      [
        'fmt',
        {
          allowed: ['--check', '--all'],
          required: ['--check'],
        },
      ],
    ]),
  ],
  [
    'dotnet',
    new Map([
      ['test', { allowed: ['--no-restore', '--no-build', '--nologo'] }],
      ['build', { allowed: ['--no-restore', '--nologo'] }],
      [
        'format',
        {
          allowed: ['--verify-no-changes', '--no-restore', '--no-build', '--nologo'],
          required: ['--verify-no-changes'],
        },
      ],
    ]),
  ],
  [
    'go',
    new Map([
      ['test', { allowed: ['.', './...', '-race', '-short', '-count=1'] }],
      ['vet', { allowed: ['.', './...'] }],
    ]),
  ],
  [
    'gradle',
    new Map([
      ['check', { allowed: ['--no-daemon', '--offline', '-q', '--quiet'] }],
      ['test', { allowed: ['--no-daemon', '--offline', '-q', '--quiet'] }],
    ]),
  ],
  [
    'gradlew',
    new Map([
      ['check', { allowed: ['--no-daemon', '--offline', '-q', '--quiet'] }],
      ['test', { allowed: ['--no-daemon', '--offline', '-q', '--quiet'] }],
    ]),
  ],
  [
    'mvn',
    new Map([
      ['test', { allowed: ['-B', '--batch-mode', '-o', '--offline', '-q', '--quiet'] }],
      ['verify', { allowed: ['-B', '--batch-mode', '-o', '--offline', '-q', '--quiet'] }],
    ]),
  ],
  [
    'mvnw',
    new Map([
      ['test', { allowed: ['-B', '--batch-mode', '-o', '--offline', '-q', '--quiet'] }],
      ['verify', { allowed: ['-B', '--batch-mode', '-o', '--offline', '-q', '--quiet'] }],
    ]),
  ],
  [
    'ruff',
    new Map([
      ['check', { allowed: ['.', '--no-cache', '-q', '--quiet'] }],
      [
        'format',
        {
          allowed: ['.', '--check', '--no-cache', '-q', '--quiet'],
          required: ['--check'],
        },
      ],
    ]),
  ],
]);

interface ParsedHealthCommand {
  executable: string;
  args: string[];
}

function rejectGateTokens(tokens: string[]): void {
  if (
    tokens.some((token) => {
      const normalized = token.toLowerCase();
      return (
        /(^|[:./_-])gate($|[:./_-])/.test(normalized) ||
        normalized.includes('pre-merge-check') ||
        normalized.includes('classify-gate-route') ||
        normalized.includes('gate-terminal-receipt') ||
        normalized.includes('gate-prepared-artifacts') ||
        normalized.includes('run-with-gate-resource') ||
        normalized.includes('pre-merge-gate-guard')
      );
    })
  ) {
    throw new Error('main-health must never schedule pnpm gate or an equivalent full gate');
  }
}

function stripPnpmSelectionOptions(input: string[]): string[] {
  if (input.some((arg) => arg === '-C' || arg === '--dir' || arg.startsWith('-C=') || arg.startsWith('--dir='))) {
    throw new Error('main-health package runners cannot change the configured repo working directory');
  }
  let args = input;
  while (['-r', '--recursive', '--workspace-root'].includes(args[0])) args = args.slice(1);
  while (['-F', '--filter'].includes(args[0])) {
    if (!args[1]) throw new Error('main-health package-runner option requires a value');
    if (args[1].startsWith('/') || args[1].split('/').includes('..')) {
      throw new Error('main-health package filters must remain inside the configured repo');
    }
    args = args.slice(2);
  }
  return args;
}

function assertAllowedArguments(executable: string, args: string[], grammar: ArgumentGrammar): void {
  if (
    args.some((arg) => !grammar.allowed.includes(arg)) ||
    grammar.required?.some((arg) => !args.includes(arg)) ||
    (grammar.anyOf && !grammar.anyOf.some((arg) => args.includes(arg)))
  ) {
    throw new Error(`main-health ${executable} arguments are outside the repo-fixed positive grammar`);
  }
}

function parsePackageScript(executable: string, tokens: string[]): void {
  let args = executable === 'pnpm' ? stripPnpmSelectionOptions(tokens.slice(1)) : tokens.slice(1);
  if (executable === 'npm') {
    if (args.length === 1 && args[0] === 'test') return;
    if (!['run', 'run-script'].includes(args[0])) {
      throw new Error('main-health npm commands must use npm test or npm run <health-script>');
    }
  }
  if (['run', 'run-script'].includes(args[0])) args = args.slice(1);
  if (args.length !== 1 || !HEALTH_SCRIPT_NAME.test(args[0])) {
    throw new Error('main-health package runners accept one check/test/lint/typecheck/health/verify script only');
  }
}

function assertPositiveGrammar(executable: string, tokens: string[]): void {
  if (['pnpm', 'npm', 'yarn'].includes(executable)) {
    parsePackageScript(executable, tokens);
    return;
  }
  if (['make', 'just'].includes(executable)) {
    if (tokens.length !== 2 || !HEALTH_TARGET_NAME.test(tokens[1])) {
      throw new Error('main-health task runners accept one health target only');
    }
    return;
  }
  const directGrammar = DIRECT_HEALTH_GRAMMARS.get(executable);
  if (directGrammar) {
    assertAllowedArguments(executable, tokens.slice(1), directGrammar);
    return;
  }
  const argumentGrammar = SUBCOMMAND_HEALTH_GRAMMARS.get(executable)?.get(tokens[1]);
  if (!argumentGrammar) {
    throw new Error('health command executable/subcommand is outside the positive allowlist');
  }
  assertAllowedArguments(executable, tokens.slice(2), argumentGrammar);
}

export function parseHealthCommand(command: string): ParsedHealthCommand {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !/^[A-Za-z0-9_./:@%+,=-]+$/.test(token))) {
    throw new Error('health command must be a shell-free executable and argument list');
  }
  const executable = tokens[0];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(executable)) {
    throw new Error('health command executable must be a canonical bare name');
  }
  rejectGateTokens(tokens);
  assertPositiveGrammar(executable, tokens);
  return { executable, args: tokens.slice(1) };
}
