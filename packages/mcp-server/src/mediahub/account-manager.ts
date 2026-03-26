/**
 * MediaHub — Account Manager
 * F139 Phase B: Encrypted credential storage (AES-256-GCM) + health lifecycle.
 *
 * Credentials are stored in Redis with per-record encryption.
 * Encryption key: MEDIAHUB_CREDENTIAL_KEY env var (base64-encoded 32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { RedisClient } from './job-store.js';
import type { HealthStatus } from './types.js';

const CRED_PREFIX = 'mediahub:cred:';
const CRED_INDEX = 'mediahub:creds';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 16;

export interface CredentialSummary {
  providerId: string;
  credentialType: string;
  healthStatus: HealthStatus;
  lastHealthAt: number;
  createdAt: number;
}

// ============ Encryption helpers ============

function encrypt(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(encryptedB64: string, ivB64: string, authTagB64: string, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedB64, 'base64')), decipher.final()]).toString('utf8');
}

// ============ AccountManager ============

export class AccountManager {
  constructor(
    private readonly redis: RedisClient,
    private readonly encryptionKey: Buffer,
  ) {
    if (encryptionKey.length !== 32) {
      throw new Error('Encryption key must be 32 bytes (AES-256)');
    }
  }

  /** Save (or overwrite) encrypted credentials for a provider */
  async saveCredential(providerId: string, credentialType: string, data: Record<string, string>): Promise<void> {
    const { encrypted, iv, authTag } = encrypt(JSON.stringify(data), this.encryptionKey);
    const now = Date.now();
    await this.redis.hset(CRED_PREFIX + providerId, {
      providerId,
      credentialType,
      encryptedData: encrypted,
      iv,
      authTag,
      createdAt: String(now),
      lastHealthStatus: 'unchecked',
      lastHealthAt: '0',
    });
    await this.redis.zadd(CRED_INDEX, now, providerId);
  }

  /** Decrypt and return credential data, or null if not found / corrupt */
  async getCredentialData(providerId: string): Promise<Record<string, string> | null> {
    const hash = await this.redis.hgetall(CRED_PREFIX + providerId);
    if (!hash['providerId']) return null;
    try {
      const plaintext = decrypt(hash['encryptedData'], hash['iv'], hash['authTag'], this.encryptionKey);
      return JSON.parse(plaintext) as Record<string, string>;
    } catch {
      return null;
    }
  }

  /** Remove stored credentials for a provider */
  async removeCredential(providerId: string): Promise<boolean> {
    const hash = await this.redis.hgetall(CRED_PREFIX + providerId);
    if (!hash['providerId']) return false;
    await this.redis.del(CRED_PREFIX + providerId);
    return true;
  }

  /** List all stored credential summaries (no decrypted data) */
  async listCredentials(): Promise<CredentialSummary[]> {
    const ids = await this.redis.zrevrangebyscore(CRED_INDEX, '+inf', '-inf', 'LIMIT', '0', '100');
    const results: CredentialSummary[] = [];
    for (const id of ids) {
      const hash = await this.redis.hgetall(CRED_PREFIX + id);
      if (!hash['providerId']) continue;
      results.push({
        providerId: id,
        credentialType: hash['credentialType'] ?? 'api_key',
        healthStatus: (hash['lastHealthStatus'] as HealthStatus) ?? 'unchecked',
        lastHealthAt: Number(hash['lastHealthAt'] ?? 0),
        createdAt: Number(hash['createdAt'] ?? 0),
      });
    }
    return results;
  }

  /** Update the health status for a stored credential */
  async updateHealthStatus(providerId: string, status: HealthStatus): Promise<void> {
    await this.redis.hset(CRED_PREFIX + providerId, {
      lastHealthStatus: status,
      lastHealthAt: String(Date.now()),
    });
  }
}
