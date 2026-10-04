import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GitHubAppManifestBeginResult } from '@cat-cafe/collective-client';
import { ensurePrivateDirectory, readPrivateFile, writeAtomicPrivate } from '@cat-cafe/shared/node-private-fs';
import { z } from 'zod';

import { CollectiveServiceError } from './errors.js';
import { ConfigurableGitHubHumanAuthProvider, type GitHubOAuthCredentials } from './github-human-auth-provider.js';
import { createSecret, digestSecret, secretMatches } from './persistence.js';

const CREDENTIAL_FILE = 'github-app-oauth.json';
const SETUP_STATE_FILE = 'github-app-setup.json';
const MANIFEST_CONVERSION_URL = 'https://api.github.com/app-manifests';

const credentialSchema = z
  .object({
    version: z.literal(1),
    githubAppId: z.number().int().positive(),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

const setupAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    stateDigest: z.string().length(64),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
  })
  .strict();

const setupStateSchema = z
  .object({
    version: z.literal(1),
    attempts: z.array(setupAttemptSchema),
  })
  .strict();

const conversionResponseSchema = z
  .object({
    id: z.number().int().positive(),
    client_id: z.string().trim().min(1),
    client_secret: z.string().trim().min(1),
  })
  .passthrough();

type SetupState = z.infer<typeof setupStateSchema>;

export interface GitHubAppManifestSetupOptions {
  readonly dataDirectory: string;
  readonly provider: ConfigurableGitHubHumanAuthProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly createSecret?: () => string;
}

export interface BeginGitHubAppManifestInput {
  readonly serviceInstanceId: string;
  readonly serviceUrl: string;
  readonly humanAuthCallbackUrl: string;
  readonly setupCallbackUrl: string;
  readonly ttlMs?: number;
}

export class GitHubAppManifestSetup {
  readonly #dataDirectory: string;
  readonly #provider: ConfigurableGitHubHumanAuthProvider;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #createSecret: () => string;
  #state: SetupState;
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: GitHubAppManifestSetupOptions, state: SetupState) {
    this.#dataDirectory = options.dataDirectory;
    this.#provider = options.provider;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#createSecret = options.createSecret ?? createSecret;
    this.#state = state;
  }

  static async open(options: GitHubAppManifestSetupOptions): Promise<GitHubAppManifestSetup> {
    await ensurePrivateDirectory(options.dataDirectory);
    const savedCredentials = await readPrivateJson(join(options.dataDirectory, CREDENTIAL_FILE), credentialSchema);
    if (savedCredentials && !options.provider.readiness.ready) {
      options.provider.configure({
        clientId: savedCredentials.clientId,
        clientSecret: savedCredentials.clientSecret,
      });
    }
    const savedState = await readPrivateJson(join(options.dataDirectory, SETUP_STATE_FILE), setupStateSchema);
    return new GitHubAppManifestSetup(options, savedState ?? { version: 1, attempts: [] });
  }

  async begin(input: BeginGitHubAppManifestInput): Promise<GitHubAppManifestBeginResult> {
    const stateSecret = this.#createSecret();
    const now = this.#now();
    await this.#transaction((state) => {
      state.attempts.push({
        attemptId: `github_app_setup_${randomUUID().replaceAll('-', '')}`,
        stateDigest: digestSecret(stateSecret),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (input.ttlMs ?? 60 * 60 * 1_000)).toISOString(),
      });
      state.attempts = state.attempts.slice(-20);
    });
    const registrationUrl = new URL('https://github.com/settings/apps/new');
    registrationUrl.searchParams.set('state', stateSecret);
    const suffix = input.serviceInstanceId.replace(/^svc_/, '').slice(0, 8);
    return {
      registrationUrl: registrationUrl.toString(),
      manifest: {
        name: `Collective Service ${suffix}`,
        url: input.serviceUrl,
        redirect_url: input.setupCallbackUrl,
        callback_urls: [input.humanAuthCallbackUrl],
        public: true,
      },
    };
  }

  async complete(input: { readonly state: string; readonly code: string }): Promise<void> {
    await this.#transaction((state) => {
      const attempt = [...state.attempts]
        .reverse()
        .find((candidate) => secretMatches(input.state, candidate.stateDigest));
      if (!attempt) throw setupError('GITHUB_APP_SETUP_INVALID', 'GitHub App setup is invalid', 401);
      if (attempt.consumedAt)
        throw setupError('GITHUB_APP_SETUP_CONSUMED', 'GitHub App setup was already consumed', 409);
      if (Date.parse(attempt.expiresAt) < this.#now()) {
        throw setupError('GITHUB_APP_SETUP_EXPIRED', 'GitHub App setup expired', 410);
      }
      attempt.consumedAt = new Date(this.#now()).toISOString();
    });
    const response = await this.#fetchImpl(`${MANIFEST_CONVERSION_URL}/${encodeURIComponent(input.code)}/conversions`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'collective-service',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw setupError('GITHUB_APP_SETUP_UPSTREAM_FAILED', 'GitHub App creation failed', 502);
    const converted = conversionResponseSchema.safeParse(await response.json());
    if (!converted.success) {
      throw setupError('GITHUB_APP_SETUP_UPSTREAM_FAILED', 'GitHub App creation returned an invalid response', 502);
    }
    const credentials: GitHubOAuthCredentials = {
      clientId: converted.data.client_id,
      clientSecret: converted.data.client_secret,
    };
    await writePrivateJson(join(this.#dataDirectory, CREDENTIAL_FILE), {
      version: 1,
      githubAppId: converted.data.id,
      ...credentials,
      createdAt: new Date(this.#now()).toISOString(),
    });
    this.#provider.configure(credentials);
  }

  async #transaction(mutator: (state: SetupState) => void): Promise<void> {
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const next = structuredClone(this.#state);
      mutator(next);
      const validated = setupStateSchema.parse(next);
      await writePrivateJson(join(this.#dataDirectory, SETUP_STATE_FILE), validated);
      this.#state = validated;
    } finally {
      release?.();
    }
  }
}

function setupError(
  code:
    | 'GITHUB_APP_SETUP_CONSUMED'
    | 'GITHUB_APP_SETUP_EXPIRED'
    | 'GITHUB_APP_SETUP_INVALID'
    | 'GITHUB_APP_SETUP_UPSTREAM_FAILED',
  message: string,
  statusCode: number,
): CollectiveServiceError {
  return new CollectiveServiceError(code, message, statusCode);
}

async function readPrivateJson<Output>(path: string, schema: z.ZodType<Output>): Promise<Output | undefined> {
  try {
    return schema.parse(JSON.parse(await readPrivateFile(path)));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeAtomicPrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
