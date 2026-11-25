import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AGY_OAUTH_FILE, agyOAuthFile } from '../../../../../../../config/agy-account.js';
import {
  canonicalWin32Path,
  hasOnlyControlledWin32Hardlinks,
  isControlledAgyOAuthAlias,
} from '../../../../../../../config/win32-fs-security.js';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { ObservedContextWindow } from '../../../../types.js';
import { type AgyVersionProbeOptions, readAgyVersion } from './agy-native-version-probe.js';

export interface AgyCapacityScope {
  readonly model: string;
  readonly cliVersion: string;
  readonly scopeId: string;
  readonly directory: string;
}

const versions = new Map<string, string>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const log = createModuleLogger('agy-native-capacity');

function executableIdentity(command: string): string {
  const stat = statSync(command);
  if (!stat.isFile()) throw new Error('AGY executable is not a regular file');
  return hash(JSON.stringify([command, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
}

/** A version probe never enters a model turn. Executable replacement invalidates the cache. */
export async function resolveAgyCapacityScope(
  input: AgyVersionProbeOptions & {
    command: string;
    profileHome: string;
    credentialHome?: string;
    model: string;
    invocationId?: string;
  },
): Promise<AgyCapacityScope | undefined> {
  try {
    input.signal?.throwIfAborted();
    const command = realpathSync(input.command);
    const executable = executableIdentity(command);
    let cliVersion = versions.get(executable);
    if (!cliVersion) {
      const text = await readAgyVersion(command, input);
      if (realpathSync(input.command) !== command || executableIdentity(command) !== executable) {
        log.warn(
          { invocationId: input.invocationId, reason: 'executable_changed' },
          'AGY capacity version unavailable',
        );
        return undefined;
      }
      cliVersion = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(text)?.[1];
      if (!cliVersion) {
        log.warn(
          { invocationId: input.invocationId, reason: 'version_output_unrecognized' },
          'AGY capacity version unavailable',
        );
        return undefined;
      }
      versions.set(executable, cliVersion);
    }
    input.signal?.throwIfAborted();
    const profileHome = canonicalWin32Path(input.profileHome);
    const config = join(profileHome, '.gemini/config');
    if (canonicalWin32Path(config) !== config) return undefined;
    const account = canonicalWin32Path(input.credentialHome ?? profileHome);
    const credential = agyOAuthFile(account);
    const credentialStat = lstatSync(credential);
    if (
      !credentialStat.isFile() ||
      credentialStat.isSymbolicLink() ||
      (credentialStat.nlink !== 1 &&
        (process.platform !== 'win32' ||
          !hasOnlyControlledWin32Hardlinks(credential, isControlledAgyOAuthAlias(account, AGY_OAUTH_FILE)))) ||
      (process.platform !== 'win32' && (credentialStat.mode & 0o077) !== 0) ||
      credentialStat.size > 16384
    )
      return undefined;
    const parsed = JSON.parse(readFileSync(credential, 'utf8')) as {
      auth_method?: unknown;
      token?: { refresh_token?: unknown };
    };
    const grant = parsed?.token?.refresh_token;
    // Access-token refresh must not change the scope. Re-login or grant rotation must.
    // A legacy keychain-only login has no file-owned grant proof and stays unavailable.
    if (parsed.auth_method !== 'consumer' || typeof grant !== 'string' || !grant) return undefined;
    const scopeId = hash(JSON.stringify([profileHome, account, hash(grant), input.model, cliVersion, executable]));
    return {
      model: input.model,
      cliVersion,
      scopeId,
      directory: join(profileHome, '.gemini/config/.cat-cafe-context-capacity', scopeId),
    };
  } catch (error) {
    input.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.name : 'unknown';
    log.warn({ invocationId: input.invocationId, reason }, 'AGY capacity scope unavailable');
    return undefined;
  }
}

function regularDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function validObservation(value: unknown, scope: AgyCapacityScope): value is ObservedContextWindow {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.provider === 'google' &&
    record.carrier === 'agy_stream_json' &&
    record.scopeId === scope.scopeId &&
    record.model === scope.model &&
    record.cliVersion === scope.cliVersion &&
    typeof record.windowTokens === 'number' &&
    Number.isSafeInteger(record.windowTokens) &&
    record.windowTokens > 16000 &&
    typeof record.observedAt === 'number' &&
    Number.isFinite(record.observedAt) &&
    record.observedAt > 0 &&
    typeof record.evidenceRef === 'string' &&
    /^agy_native_checkpoint:[^\s:]+:\d+$/.test(record.evidenceRef)
  );
}

/** Immutable samples avoid lost-update expansion when two conversations observe checkpoints together. */
export function readAgyObservedWindow(scope: AgyCapacityScope): ObservedContextWindow | undefined {
  try {
    if (!regularDirectory(join(scope.directory, '..')) || !regularDirectory(scope.directory)) return undefined;
    const samples = readdirSync(scope.directory).filter((name) => /^\d+\.json$/.test(name));
    const first = samples.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))[0];
    if (!first) return undefined;
    const path = join(scope.directory, first);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) return undefined;
    const observation: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return validObservation(observation, scope) && `${observation.windowTokens}.json` === first
      ? observation
      : undefined;
  } catch {
    return undefined;
  }
}

export function recordAgyObservedWindow(
  scope: AgyCapacityScope,
  observation: ObservedContextWindow,
): ObservedContextWindow {
  if (!validObservation(observation, scope)) throw new Error('invalid AGY checkpoint capacity observation');
  const parent = join(scope.directory, '..');
  for (const path of [parent, scope.directory]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !regularDirectory(path)) throw new Error('AGY capacity observation path is not a private directory');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const temporary = join(scope.directory, `.pending-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600, flag: 'wx' });
    // Same-token samples have the same ceiling; replacing their provenance cannot expand it.
    renameSync(temporary, join(scope.directory, `${observation.windowTokens}.json`));
  } finally {
    rmSync(temporary, { force: true });
  }
  const persisted = readAgyObservedWindow(scope);
  if (!persisted) throw new Error('AGY checkpoint capacity observation could not be read back');
  return persisted;
}
