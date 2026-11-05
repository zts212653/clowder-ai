import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const ISSUER = 'clowder-plugin-host';
const ALGORITHM = 'EdDSA';
const EXTERNAL_MAX_TTL_SECONDS = 180 * 24 * 60 * 60;
const NATIVE_MAX_TTL_SECONDS = 60 * 60;
const ROTATE_AFTER_MS = 180 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 60;
const CLOCK_SKEW_MS = CLOCK_SKEW_SECONDS * 1_000;

export type PluginCapabilityAudience = 'plugin-native' | 'plugin-external';

export interface PluginCapabilityClaims {
  readonly iss: typeof ISSUER;
  readonly aud: PluginCapabilityAudience;
  readonly sub: string;
  readonly cap: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly kid: string;
  readonly boot?: string;
  readonly act?: string;
}

export interface IssuedPluginCapabilityToken {
  readonly token: string;
  readonly claims: PluginCapabilityClaims;
  readonly tokenId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly refreshRecommendedAt: number;
}

interface CurrentKey {
  readonly kid: string;
  readonly createdAt: number;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

interface PreviousKey {
  readonly kid: string;
  readonly createdAt: number;
  readonly stoppedSigningAt: number;
  readonly safeDeleteAt: number;
  readonly publicKeyPem: string;
}

interface StoredKeyring {
  readonly schemaVersion: 1;
  readonly current: CurrentKey;
  readonly previous?: PreviousKey;
}

export type PluginCapabilityTokenErrorCode =
  | 'KEYRING_INVALID'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_AUDIENCE_MISMATCH'
  | 'TOKEN_SUBJECT_MISMATCH'
  | 'TOKEN_CAPABILITY_MISMATCH'
  | 'TOKEN_BOOT_MISMATCH'
  | 'TOKEN_ACTIVATION_MISMATCH';

export class PluginCapabilityTokenError extends Error {
  constructor(
    readonly code: PluginCapabilityTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FilePluginCapabilityKeyringOptions {
  readonly path: string;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

const queues = new Map<string, Promise<void>>();

function queuePath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(path, settled);
  settled.finally(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return current;
}

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > 512 || /\s/u.test(value)) {
    throw new PluginCapabilityTokenError('TOKEN_INVALID', `Invalid ${name}`);
  }
}

function generateKey(now: number, randomId: () => string): CurrentKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid: randomId(),
    createdAt: now,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function canonicalBase64Url(value: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token encoding');
  }
  if (decoded.toString('base64url') !== value) {
    throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token encoding');
  }
  return decoded;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token');
  }
  return value as Record<string, unknown>;
}

function parseJsonPart(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(canonicalBase64Url(value).toString('utf8')));
  } catch (error) {
    if (error instanceof PluginCapabilityTokenError) throw error;
    throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token JSON');
  }
}

function parseClaims(value: Record<string, unknown>): PluginCapabilityClaims {
  const audience = value.aud;
  if (
    value.iss !== ISSUER ||
    (audience !== 'plugin-native' && audience !== 'plugin-external') ||
    typeof value.sub !== 'string' ||
    typeof value.cap !== 'string' ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    typeof value.jti !== 'string' ||
    typeof value.kid !== 'string'
  ) {
    throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token claims');
  }
  assertIdentifier(value.sub, 'token subject');
  assertIdentifier(value.cap, 'token capability');
  assertIdentifier(value.jti, 'token id');
  assertIdentifier(value.kid, 'key id');
  if (audience === 'plugin-native') {
    if (typeof value.boot !== 'string' || typeof value.act !== 'string') {
      throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Native token requires boot and activation claims');
    }
    assertIdentifier(value.boot, 'boot id');
    assertIdentifier(value.act, 'activation id');
  } else if (value.boot !== undefined || value.act !== undefined) {
    throw new PluginCapabilityTokenError('TOKEN_INVALID', 'External token cannot carry native claims');
  }
  return value as unknown as PluginCapabilityClaims;
}

function validCurrent(value: unknown): value is CurrentKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const key = value as Partial<CurrentKey>;
  return (
    typeof key.kid === 'string' &&
    key.kid.length > 0 &&
    Number.isSafeInteger(key.createdAt) &&
    typeof key.privateKeyPem === 'string' &&
    typeof key.publicKeyPem === 'string'
  );
}

function validPrevious(value: unknown): value is PreviousKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const key = value as Partial<PreviousKey>;
  return (
    typeof key.kid === 'string' &&
    key.kid.length > 0 &&
    Number.isSafeInteger(key.createdAt) &&
    Number.isSafeInteger(key.stoppedSigningAt) &&
    Number.isSafeInteger(key.safeDeleteAt) &&
    typeof key.publicKeyPem === 'string'
  );
}

function validateKeyring(value: unknown): StoredKeyring {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginCapabilityTokenError('KEYRING_INVALID', 'Invalid plugin capability keyring');
  }
  const keyring = value as Partial<StoredKeyring>;
  if (
    keyring.schemaVersion !== 1 ||
    !validCurrent(keyring.current) ||
    (keyring.previous !== undefined && !validPrevious(keyring.previous)) ||
    keyring.previous?.kid === keyring.current.kid
  ) {
    throw new PluginCapabilityTokenError('KEYRING_INVALID', 'Invalid plugin capability keyring');
  }
  try {
    const privateKey = createPrivateKey(keyring.current.privateKeyPem);
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    if (derived !== createPublicKey(keyring.current.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString()) {
      throw new Error('key pair mismatch');
    }
    if (keyring.previous) createPublicKey(keyring.previous.publicKeyPem);
  } catch {
    throw new PluginCapabilityTokenError('KEYRING_INVALID', 'Invalid plugin capability key material');
  }
  return keyring as StoredKeyring;
}

export class FilePluginCapabilityKeyring {
  readonly #path: string;
  readonly #now: () => number;
  readonly #randomId: () => string;

  constructor(options: FilePluginCapabilityKeyringOptions) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
  }

  issueExternal(input: {
    readonly instanceId: string;
    readonly capabilityId: string;
    readonly ttlSeconds: number;
  }): Promise<IssuedPluginCapabilityToken> {
    return this.issue('plugin-external', input);
  }

  issueNative(input: {
    readonly instanceId: string;
    readonly capabilityId: string;
    readonly ttlSeconds: number;
    readonly bootId: string;
    readonly activationId: string;
  }): Promise<IssuedPluginCapabilityToken> {
    return this.issue('plugin-native', input);
  }

  verifyExternal(
    token: string,
    expected: { readonly instanceId: string; readonly capabilityId: string },
  ): Promise<PluginCapabilityClaims> {
    return this.verify(token, 'plugin-external', expected);
  }

  /** Public-route verification: the signed subject selects the candidate instance before live authority checks. */
  verifyExternalToken(token: string): Promise<PluginCapabilityClaims> {
    return this.verifySigned(token, 'plugin-external');
  }

  verifyNative(
    token: string,
    expected: {
      readonly instanceId: string;
      readonly capabilityId: string;
      readonly bootId: string;
      readonly activationId: string;
    },
  ): Promise<PluginCapabilityClaims> {
    return this.verify(token, 'plugin-native', expected);
  }

  private issue(
    audience: PluginCapabilityAudience,
    input: {
      readonly instanceId: string;
      readonly capabilityId: string;
      readonly ttlSeconds: number;
      readonly bootId?: string;
      readonly activationId?: string;
    },
  ): Promise<IssuedPluginCapabilityToken> {
    return queuePath(this.#path, async () => {
      assertIdentifier(input.instanceId, 'plugin instance id');
      assertIdentifier(input.capabilityId, 'capability id');
      const maximum = audience === 'plugin-external' ? EXTERNAL_MAX_TTL_SECONDS : NATIVE_MAX_TTL_SECONDS;
      if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0 || input.ttlSeconds > maximum) {
        throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token TTL');
      }
      if (audience === 'plugin-native') {
        assertIdentifier(input.bootId ?? '', 'boot id');
        assertIdentifier(input.activationId ?? '', 'activation id');
      }
      const now = this.#now();
      const keyring = await this.rotateIfEligible(await this.readOrCreate(now), now);
      const issuedAt = Math.floor(now / 1_000);
      const expiresAt = issuedAt + input.ttlSeconds;
      const claims: PluginCapabilityClaims = {
        iss: ISSUER,
        aud: audience,
        sub: input.instanceId,
        cap: input.capabilityId,
        iat: issuedAt,
        exp: expiresAt,
        jti: this.#randomId(),
        kid: keyring.current.kid,
        ...(audience === 'plugin-native' ? { boot: input.bootId!, act: input.activationId! } : {}),
      };
      const header = Buffer.from(JSON.stringify({ alg: ALGORITHM, kid: keyring.current.kid, typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const material = `${header}.${payload}`;
      const signature = signBytes(
        null,
        Buffer.from(material),
        createPrivateKey(keyring.current.privateKeyPem),
      ).toString('base64url');
      return {
        token: `${material}.${signature}`,
        claims,
        tokenId: claims.jti,
        issuedAt,
        expiresAt,
        refreshRecommendedAt: issuedAt + Math.max(1, Math.floor(input.ttlSeconds * 0.8)),
      };
    });
  }

  private verify(
    token: string,
    audience: PluginCapabilityAudience,
    expected: {
      readonly instanceId: string;
      readonly capabilityId: string;
      readonly bootId?: string;
      readonly activationId?: string;
    },
  ): Promise<PluginCapabilityClaims> {
    return this.verifySigned(token, audience).then((claims) => {
      if (claims.sub !== expected.instanceId) {
        throw new PluginCapabilityTokenError('TOKEN_SUBJECT_MISMATCH', 'Capability token subject mismatch');
      }
      if (claims.cap !== expected.capabilityId) {
        throw new PluginCapabilityTokenError('TOKEN_CAPABILITY_MISMATCH', 'Capability token capability mismatch');
      }
      if (audience === 'plugin-native' && claims.boot !== expected.bootId) {
        throw new PluginCapabilityTokenError('TOKEN_BOOT_MISMATCH', 'Capability token boot mismatch');
      }
      if (audience === 'plugin-native' && claims.act !== expected.activationId) {
        throw new PluginCapabilityTokenError('TOKEN_ACTIVATION_MISMATCH', 'Capability token activation mismatch');
      }
      return claims;
    });
  }

  private verifySigned(token: string, audience: PluginCapabilityAudience): Promise<PluginCapabilityClaims> {
    return queuePath(this.#path, async () => {
      if (token.length === 0 || token.length > 8_192 || /\s/u.test(token)) {
        throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token');
      }
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token');
      }
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
      const header = parseJsonPart(encodedHeader);
      if (header.alg !== ALGORITHM || header.typ !== 'JWT' || typeof header.kid !== 'string') {
        throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Unsupported capability token header');
      }
      const claims = parseClaims(parseJsonPart(encodedPayload));
      if (claims.kid !== header.kid) {
        throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Capability token key id mismatch');
      }
      const keyring = await this.readExisting();
      const publicKeyPem =
        keyring.current.kid === header.kid
          ? keyring.current.publicKeyPem
          : keyring.previous?.kid === header.kid
            ? keyring.previous.publicKeyPem
            : undefined;
      if (
        publicKeyPem === undefined ||
        !verifyBytes(
          null,
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          createPublicKey(publicKeyPem),
          canonicalBase64Url(encodedSignature),
        )
      ) {
        throw new PluginCapabilityTokenError('TOKEN_INVALID', 'Invalid capability token signature');
      }
      const now = Math.floor(this.#now() / 1_000);
      if (claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp <= claims.iat || now > claims.exp + CLOCK_SKEW_SECONDS) {
        throw new PluginCapabilityTokenError('TOKEN_EXPIRED', 'Capability token is expired or not yet valid');
      }
      if (claims.aud !== audience) {
        throw new PluginCapabilityTokenError('TOKEN_AUDIENCE_MISMATCH', 'Capability token audience mismatch');
      }
      return claims;
    });
  }

  private async readOrCreate(now: number): Promise<StoredKeyring> {
    try {
      return await this.readExisting();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const keyring: StoredKeyring = { schemaVersion: 1, current: generateKey(now, this.#randomId) };
    await this.writeKeyring(keyring);
    return keyring;
  }

  private async readExisting(): Promise<StoredKeyring> {
    const metadata = await stat(this.#path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new PluginCapabilityTokenError('KEYRING_INVALID', 'Plugin capability keyring permissions are invalid');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#path, 'utf8'));
    } catch {
      throw new PluginCapabilityTokenError('KEYRING_INVALID', 'Plugin capability keyring is unreadable');
    }
    return validateKeyring(parsed);
  }

  private async rotateIfEligible(keyring: StoredKeyring, now: number): Promise<StoredKeyring> {
    if (now - keyring.current.createdAt < ROTATE_AFTER_MS) return keyring;
    if (keyring.previous && now < keyring.previous.safeDeleteAt) return keyring;
    const next: StoredKeyring = {
      schemaVersion: 1,
      current: generateKey(now, this.#randomId),
      previous: {
        kid: keyring.current.kid,
        createdAt: keyring.current.createdAt,
        stoppedSigningAt: now,
        safeDeleteAt: now + EXTERNAL_MAX_TTL_SECONDS * 1_000 + CLOCK_SKEW_MS,
        publicKeyPem: keyring.current.publicKeyPem,
      },
    };
    await this.writeKeyring(next);
    return next;
  }

  private async writeKeyring(keyring: StoredKeyring): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(keyring, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.#path);
    await chmod(this.#path, 0o600);
    const directory = await open(dirname(this.#path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
