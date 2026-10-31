export interface RecoveryCliArgs {
  apply: boolean;
  help: boolean;
  manifestPath?: string;
  journalPath?: string;
  redisUrl?: string;
  keyPrefix?: string;
  approvalRef?: string;
  expectedManifestSha256?: string;
  confirmation?: string;
}

type ValueField = Exclude<keyof RecoveryCliArgs, 'apply' | 'help'>;

const VALUE_FLAGS: Record<string, ValueField> = {
  '--manifest': 'manifestPath',
  '--journal': 'journalPath',
  '--redis-url': 'redisUrl',
  '--key-prefix': 'keyPrefix',
  '--approval-ref': 'approvalRef',
  '--expected-manifest-sha256': 'expectedManifestSha256',
  '--confirm': 'confirmation',
};

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function validateParsedArgs(parsed: RecoveryCliArgs): RecoveryCliArgs {
  if (parsed.help) return parsed;
  if (!parsed.manifestPath) throw new Error('--manifest is required');
  if (parsed.apply && !parsed.journalPath) throw new Error('--journal is required with --apply');
  return parsed;
}

export function parseRecoveryCliArgs(argv: readonly string[]): RecoveryCliArgs {
  const parsed: RecoveryCliArgs = { apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) throw new Error(`missing argument at index ${index}`);
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.apply = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    const field = VALUE_FLAGS[arg];
    if (!field) throw new Error(`unknown argument: ${arg}`);
    parsed[field] = readValue(argv, index, arg);
    index += 1;
  }

  return validateParsedArgs(parsed);
}
