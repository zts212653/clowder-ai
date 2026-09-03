import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type AuditEvent,
  type AuditEventInput,
  AuditEventTypes,
  type EventAuditLog,
} from '../orchestration/EventAuditLog.js';

const HANDLE_PREFIX = 'sch1';
const SECRET_BYTES = 32;
const IV_BYTES = 12;
const DEFAULT_TTL_MS = 30 * 60_000;

export const PILOT_SKILL_ID = 'workspace-navigator' as const;
export const WORKSPACE_NAVIGATOR_CONSUMER_ID = 'workspace-navigator.navigate.v1' as const;

const scopeSchema = z
  .object({
    userId: z.string().trim().min(1).max(240),
    threadId: z.string().trim().min(1).max(240),
    invocationId: z.string().trim().min(1).max(240),
    catId: z.string().trim().min(1).max(120),
  })
  .strict();

const coordinateSchema = z
  .object({
    skillId: z.literal(PILOT_SKILL_ID),
    skillRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    consumerId: z.literal(WORKSPACE_NAVIGATOR_CONSUMER_ID),
    scope: scopeSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type SkillConsumptionScope = z.infer<typeof scopeSchema>;
type SkillConsumptionCoordinate = z.infer<typeof coordinateSchema>;

export type WorkspaceNavigationDeliveryOutcome = {
  kind: 'workspace_navigation_delivery.v1';
  deliveryStatus: 'applied' | 'queued' | 'blocked' | 'unconfirmed';
};

export type WorkspaceNavigationDismissedOutcome = {
  kind: 'workspace_navigation_applicability.v1';
  decision: 'not_applicable';
  reason: 'alternate_native_shortcut' | 'outside_skill_scope';
};

export type SkillConsumptionReceipt = {
  v: 1;
  receiptId: string;
  skillId: typeof PILOT_SKILL_ID;
  skillRevision: string;
  consumerId: typeof WORKSPACE_NAVIGATOR_CONSUMER_ID;
  invocationId: string;
  threadId: string;
  catId: string;
  consumption: 'applied' | 'dismissed';
  outcome: WorkspaceNavigationDeliveryOutcome | WorkspaceNavigationDismissedOutcome;
  occurredAt: number;
  applicabilityAtWrite: 'current';
};

export type SkillPreparation = {
  state: 'prepared';
  handle: string;
  skillId: typeof PILOT_SKILL_ID;
  skillRevision: string;
  consumerId: typeof WORKSPACE_NAVIGATOR_CONSUMER_ID;
  expiresAt: number;
};

export type SkillConsumptionVerificationFailure =
  | 'invalid_handle'
  | 'scope_mismatch'
  | 'consumer_mismatch'
  | 'expired'
  | 'source_revision_changed'
  | 'already_consumed';

type SkillConsumptionAuditLog = Pick<EventAuditLog, 'append'>;

function sameScope(left: SkillConsumptionScope, right: SkillConsumptionScope): boolean {
  return (
    left.userId === right.userId &&
    left.threadId === right.threadId &&
    left.invocationId === right.invocationId &&
    left.catId === right.catId
  );
}

async function listPackageEntries(root: string, relativeRoot = ''): Promise<Array<{ path: string; bytes: Buffer }>> {
  const directory = join(root, relativeRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  const output: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(...(await listPackageEntries(root, relativePath)));
      continue;
    }
    if (entry.isFile()) {
      output.push({ path: relativePath, bytes: await readFile(join(root, relativePath)) });
      continue;
    }
    if (entry.isSymbolicLink()) {
      output.push({ path: relativePath, bytes: Buffer.from(`symlink:${await readlink(join(root, relativePath))}`) });
    }
  }
  return output;
}

/** Hash every file path and byte in one skill package, not just SKILL.md. */
export async function computeSkillPackageRevision(skillSourceRoot: string, skillId: string): Promise<string> {
  const packageRoot = join(skillSourceRoot, skillId);
  const entries = await listPackageEntries(packageRoot);
  if (!entries.some((entry) => entry.path === 'SKILL.md')) {
    throw new Error(`Skill package is missing SKILL.md: ${skillId}`);
  }
  const hash = createHash('sha256');
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    const sizes = Buffer.alloc(8);
    sizes.writeUInt32BE(pathBytes.length, 0);
    sizes.writeUInt32BE(entry.bytes.length, 4);
    hash.update(sizes).update(pathBytes).update(entry.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export class SkillConsumptionReceiptService {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly handleStates = new Map<string, 'pending' | 'recorded'>();

  constructor(
    private readonly options: {
      skillSourceRoot: string;
      auditLog: SkillConsumptionAuditLog;
      secret?: Buffer;
      now?: () => number;
      ttlMs?: number;
    },
  ) {
    this.secret = Buffer.from(options.secret ?? randomBytes(SECRET_BYTES));
    if (this.secret.length !== SECRET_BYTES) throw new Error(`Skill receipt secret must be ${SECRET_BYTES} bytes`);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async prepare(
    skillId: string,
    scope: SkillConsumptionScope,
  ): Promise<{ ok: true; preparation: SkillPreparation } | { ok: false; reason: 'skill_unsupported' }> {
    if (skillId !== PILOT_SKILL_ID) return { ok: false, reason: 'skill_unsupported' };
    const validatedScope = scopeSchema.parse(scope);
    const skillRevision = await computeSkillPackageRevision(this.options.skillSourceRoot, skillId);
    const coordinate = coordinateSchema.parse({
      skillId,
      skillRevision,
      consumerId: WORKSPACE_NAVIGATOR_CONSUMER_ID,
      scope: validatedScope,
      expiresAt: this.now() + this.ttlMs,
    });
    return {
      ok: true,
      preparation: {
        state: 'prepared',
        handle: this.encrypt(coordinate),
        skillId,
        skillRevision,
        consumerId: coordinate.consumerId,
        expiresAt: coordinate.expiresAt,
      },
    };
  }

  async verifyPrepared(
    handle: string,
    scope: SkillConsumptionScope,
    consumerId: string,
  ): Promise<
    { ok: true; coordinate: SkillConsumptionCoordinate } | { ok: false; reason: SkillConsumptionVerificationFailure }
  > {
    const handleKey = createHash('sha256').update(handle).digest('hex');
    if (this.handleStates.has(handleKey)) return { ok: false, reason: 'already_consumed' };
    const coordinate = this.decrypt(handle);
    if (!coordinate) return { ok: false, reason: 'invalid_handle' };
    const validatedScope = scopeSchema.safeParse(scope);
    if (!validatedScope.success || !sameScope(coordinate.scope, validatedScope.data)) {
      return { ok: false, reason: 'scope_mismatch' };
    }
    if (coordinate.consumerId !== consumerId) return { ok: false, reason: 'consumer_mismatch' };
    if (this.now() >= coordinate.expiresAt) return { ok: false, reason: 'expired' };
    const currentRevision = await computeSkillPackageRevision(this.options.skillSourceRoot, coordinate.skillId).catch(
      () => null,
    );
    if (currentRevision !== coordinate.skillRevision) return { ok: false, reason: 'source_revision_changed' };
    return { ok: true, coordinate };
  }

  async recordApplied(input: {
    handle: string;
    scope: SkillConsumptionScope;
    outcome: WorkspaceNavigationDeliveryOutcome;
  }): Promise<
    { ok: true; receipt: SkillConsumptionReceipt } | { ok: false; reason: SkillConsumptionVerificationFailure }
  > {
    return this.record(input.handle, input.scope, 'applied', input.outcome);
  }

  async recordDismissed(input: {
    handle: string;
    scope: SkillConsumptionScope;
    reason: WorkspaceNavigationDismissedOutcome['reason'];
  }): Promise<
    { ok: true; receipt: SkillConsumptionReceipt } | { ok: false; reason: SkillConsumptionVerificationFailure }
  > {
    return this.record(input.handle, input.scope, 'dismissed', {
      kind: 'workspace_navigation_applicability.v1',
      decision: 'not_applicable',
      reason: input.reason,
    });
  }

  async classifyApplicability(
    receipt: Pick<SkillConsumptionReceipt, 'skillId' | 'skillRevision'>,
  ): Promise<'current' | 'stale'> {
    const currentRevision = await computeSkillPackageRevision(this.options.skillSourceRoot, receipt.skillId).catch(
      () => null,
    );
    return currentRevision === receipt.skillRevision ? 'current' : 'stale';
  }

  private async record(
    handle: string,
    scope: SkillConsumptionScope,
    consumption: SkillConsumptionReceipt['consumption'],
    outcome: SkillConsumptionReceipt['outcome'],
  ): Promise<
    { ok: true; receipt: SkillConsumptionReceipt } | { ok: false; reason: SkillConsumptionVerificationFailure }
  > {
    const verified = await this.verifyPrepared(handle, scope, WORKSPACE_NAVIGATOR_CONSUMER_ID);
    if (!verified.ok) return verified;
    const handleKey = createHash('sha256').update(handle).digest('hex');
    if (this.handleStates.has(handleKey)) return { ok: false, reason: 'already_consumed' };
    this.handleStates.set(handleKey, 'pending');
    try {
      const coordinate = verified.coordinate;
      const input: AuditEventInput = {
        type: AuditEventTypes.SKILL_CONSUMPTION_RECEIPT,
        threadId: coordinate.scope.threadId,
        data: {
          v: 1,
          skillId: coordinate.skillId,
          skillRevision: coordinate.skillRevision,
          consumerId: coordinate.consumerId,
          invocationId: coordinate.scope.invocationId,
          catId: coordinate.scope.catId,
          consumption,
          outcome,
        },
      };
      const event = await this.options.auditLog.append(input);
      this.handleStates.set(handleKey, 'recorded');
      return { ok: true, receipt: this.toReceipt(event, coordinate, consumption, outcome) };
    } catch (error) {
      this.handleStates.delete(handleKey);
      throw error;
    }
  }

  private toReceipt(
    event: AuditEvent,
    coordinate: SkillConsumptionCoordinate,
    consumption: SkillConsumptionReceipt['consumption'],
    outcome: SkillConsumptionReceipt['outcome'],
  ): SkillConsumptionReceipt {
    return {
      v: 1,
      receiptId: event.id,
      skillId: coordinate.skillId,
      skillRevision: coordinate.skillRevision,
      consumerId: coordinate.consumerId,
      invocationId: coordinate.scope.invocationId,
      threadId: coordinate.scope.threadId,
      catId: coordinate.scope.catId,
      consumption,
      outcome,
      occurredAt: event.timestamp,
      applicabilityAtWrite: 'current',
    };
  }

  private encrypt(coordinate: SkillConsumptionCoordinate): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(coordinate), 'utf8'), cipher.final()]);
    return [
      HANDLE_PREFIX,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  private decrypt(handle: string): SkillConsumptionCoordinate | null {
    if (handle.length > 2_000) return null;
    const parts = handle.split('.');
    if (parts.length !== 4 || parts[0] !== HANDLE_PREFIX) return null;
    try {
      const iv = Buffer.from(parts[1], 'base64url');
      const ciphertext = Buffer.from(parts[2], 'base64url');
      const tag = Buffer.from(parts[3], 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.secret, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = coordinateSchema.safeParse(JSON.parse(plaintext));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
