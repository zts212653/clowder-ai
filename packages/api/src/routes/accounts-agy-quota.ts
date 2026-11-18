import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type AgyKeychainIdentityInspector,
  type AgyQuotaSampleTarget,
  resolveAgyQuotaExecutionOwner,
} from '../config/agy-quota-identity.js';
import { readAgyQuota, recordAgyQuota } from '../config/agy-quota-store.js';
import { prepareAgyNativeKeychain } from '../domains/cats/services/agents/providers/agy-native/agy-native-keychain.js';
import { isolatedOAuthEnv } from '../domains/cats/services/agents/providers/agy-native/launch/agy-native-launch-env.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { parseAgyCliUsageOutput } from './agy-cli-usage-parser.js';
import type { CodexUsageItem } from './quota.js';

const execFileAsync = promisify(execFile);
const querySchema = z.object({ projectPath: z.string().optional() }).strict();

export type AgyAccountQuotaSampler = (
  target: AgyQuotaSampleTarget,
) => Promise<{ observedAt: number; items: CodexUsageItem[] }>;

function ensureSafeSpawnCwd(homePath: string): string {
  const cwd = join(homePath, 'cwd');
  const st = lstatSync(cwd, { throwIfNoEntry: false });
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw new Error('agy_quota_cwd_unsafe');
  }
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

export function buildAgyUsageProcessEnv(target: AgyQuotaSampleTarget): NodeJS.ProcessEnv {
  const raw = isolatedOAuthEnv(target.homePath);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (target.usesKeychain) {
    delete env.SSH_TTY;
    delete env.SSH_CLIENT;
    delete env.SSH_CONNECTION;
  } else if (target.kind === 'cli_file') {
    env.SSH_TTY = 'cat-cafe-file-auth';
  }
  return env;
}

const defaultAgyAccountQuotaSampler: AgyAccountQuotaSampler = async (target) => {
  const agyCommand = resolveCliCommand('agy');
  if (!agyCommand) throw new Error('agy_quota_cli_missing');
  if (target.usesKeychain && process.platform === 'darwin') {
    await prepareAgyNativeKeychain({ profileHome: target.homePath });
  }
  const cwd = ensureSafeSpawnCwd(target.homePath);
  const env = buildAgyUsageProcessEnv(target);
  const { stdout } = await execFileAsync(
    agyCommand,
    ['--app_data_dir=.gemini/antigravity-cli', '--output-format', 'json', '-p', '/usage'],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 512 * 1024,
    },
  );
  const observedAt = Date.now();
  const items = parseAgyCliUsageOutput(stdout);
  return { observedAt, items };
};

export async function queryAgyAccountQuota(
  root: string,
  ref: string,
  sample: AgyAccountQuotaSampler = defaultAgyAccountQuotaSampler,
  keychainIdentityInspector?: AgyKeychainIdentityInspector,
) {
  const owner = await resolveAgyQuotaExecutionOwner(root, ref, { keychainIdentityInspector });
  if (!owner) throw new Error('agy_quota_account_required');
  if (!owner.snapshot.credentialVersion) throw new Error('agy_quota_owner_unknown');
  const { observedAt, items } = await sample(owner.target);
  if (!items.length) throw new Error('agy_quota_reading_unavailable');
  const outcome = await recordAgyQuota({ root, account: owner.snapshot, items, observedAt, keychainIdentityInspector });
  if (outcome === 'credential_changed') {
    throw new Error('agy_quota_credential_changed');
  }
  if (outcome === 'invalid') {
    throw new Error('agy_quota_reading_unavailable');
  }
  const agyQuota = readAgyQuota(root, ref, owner.snapshot.credentialVersion);
  if (!agyQuota) throw new Error('agy_quota_reading_unavailable');
  return { accountRef: ref, agyQuota };
}

function mapAgyQuotaRouteError(error: unknown): { status: 409 | 503; code: string } {
  const raw = error instanceof Error ? error.message : '';
  const status = raw === 'agy_quota_credential_changed' ? 409 : 503;
  const code = raw.startsWith('agy_quota_') ? raw : 'agy_quota_reading_unavailable';
  return { status, code };
}

export function registerAgyQuotaRoutes(
  app: FastifyInstance,
  sample: AgyAccountQuotaSampler = defaultAgyAccountQuotaSampler,
  keychainIdentityInspector?: AgyKeychainIdentityInspector,
): void {
  app.post('/api/accounts/:profileId/agy/quota', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const parsed = querySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const root = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!root) return reply.code(400).send({ error: 'Invalid project path' });
    const { profileId } = request.params as { profileId: string };
    try {
      return await queryAgyAccountQuota(root, profileId, sample, keychainIdentityInspector);
    } catch (error) {
      const mapped = mapAgyQuotaRouteError(error);
      return reply.code(mapped.status).send({ error: mapped.code });
    }
  });
}
