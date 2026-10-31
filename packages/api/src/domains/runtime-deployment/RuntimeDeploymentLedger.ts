import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DeploymentService } from '@cat-cafe/shared';
import { z } from 'zod';

const deploymentIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const revisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .nullable();
const exitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clean'), completedAt: z.number().nonnegative(), signal: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal('startup_failed'), completedAt: z.number().nonnegative(), reason: z.string().min(1) })
    .strict(),
]);
const bootSchema = z
  .object({
    bootId: z.string().min(1),
    bootSequence: z.number().int().positive(),
    deploymentId: deploymentIdSchema,
    runningRevision: revisionSchema,
    startedAt: z.number().nonnegative(),
    readyAt: z.number().nonnegative().optional(),
    readyServices: z.array(z.enum(['api', 'web'])),
    serviceReadyAt: z
      .object({ api: z.number().nonnegative().optional(), web: z.number().nonnegative().optional() })
      .strict(),
    exit: exitSchema.optional(),
  })
  .strict();
const stateSchema = z
  .object({
    v: z.literal(1),
    installationId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    deployments: z.record(z.array(bootSchema)),
  })
  .strict();

export type RuntimeDeploymentBootRecord = z.infer<typeof bootSchema>;
type RuntimeDeploymentLedgerState = z.infer<typeof stateSchema>;

export class RuntimeDeploymentLedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeDeploymentLedgerError';
  }
}

export interface RuntimeDeploymentLedgerOptions {
  readonly file: string;
  readonly installationId: string;
  readonly now?: () => number;
  readonly createBootId?: () => string;
  readonly historyLimit?: number;
}

export class RuntimeDeploymentLedger {
  private readonly now: () => number;
  private readonly createBootId: () => string;
  private readonly historyLimit: number;
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeDeploymentLedgerOptions) {
    this.now = options.now ?? Date.now;
    this.createBootId = options.createBootId ?? randomUUID;
    this.historyLimit = options.historyLimit ?? 64;
    if (!stateSchema.shape.installationId.safeParse(options.installationId).success) {
      throw new RuntimeDeploymentLedgerError('invalid runtime installation id');
    }
  }

  beginBoot(input: {
    readonly deploymentId: string;
    readonly runningRevision: string | null;
  }): Promise<RuntimeDeploymentBootRecord> {
    return this.mutate(input.deploymentId, (history) => {
      if (!revisionSchema.safeParse(input.runningRevision).success) {
        throw new RuntimeDeploymentLedgerError('invalid running revision');
      }
      const boot: RuntimeDeploymentBootRecord = {
        bootId: this.createBootId(),
        bootSequence: (history[0]?.bootSequence ?? 0) + 1,
        deploymentId: input.deploymentId,
        runningRevision: input.runningRevision,
        startedAt: this.now(),
        readyServices: [],
        serviceReadyAt: {},
      };
      history.unshift(boot);
      history.splice(this.historyLimit);
      return boot;
    });
  }

  markReady(input: {
    readonly deploymentId: string;
    readonly bootId: string;
    readonly services: readonly DeploymentService[];
  }): Promise<RuntimeDeploymentBootRecord> {
    return this.mutate(input.deploymentId, (history) => {
      const current = this.requireCurrent(history, input.bootId);
      if (current.exit) throw new RuntimeDeploymentLedgerError('cannot mark an exited boot ready');
      const observedAt = this.now();
      const readyServices = [...new Set([...current.readyServices, ...input.services])].sort() as DeploymentService[];
      const serviceReadyAt = { ...current.serviceReadyAt };
      for (const service of input.services) serviceReadyAt[service] ??= observedAt;
      const allServicesReady = readyServices.includes('api') && readyServices.includes('web');
      const updated = {
        ...current,
        ...(allServicesReady ? { readyAt: current.readyAt ?? observedAt } : {}),
        readyServices,
        serviceReadyAt,
      };
      history[0] = updated;
      return updated;
    });
  }

  completeCleanExit(input: {
    readonly deploymentId: string;
    readonly bootId: string;
    readonly signal: string;
  }): Promise<RuntimeDeploymentBootRecord> {
    return this.mutate(input.deploymentId, (history) => {
      const current = this.requireCurrent(history, input.bootId);
      if (current.exit) throw new RuntimeDeploymentLedgerError('boot exit is already recorded');
      const updated = {
        ...current,
        exit: { kind: 'clean' as const, completedAt: this.now(), signal: input.signal },
      };
      history[0] = updated;
      return updated;
    });
  }

  recordStartupFailure(input: {
    readonly deploymentId: string;
    readonly bootId: string;
    readonly reason: string;
  }): Promise<RuntimeDeploymentBootRecord> {
    return this.mutate(input.deploymentId, (history) => {
      const current = this.requireCurrent(history, input.bootId);
      if (current.exit) throw new RuntimeDeploymentLedgerError('boot exit is already recorded');
      if (current.readyAt !== undefined) throw new RuntimeDeploymentLedgerError('ready boot is not a startup failure');
      const updated = {
        ...current,
        exit: { kind: 'startup_failed' as const, completedAt: this.now(), reason: input.reason },
      };
      history[0] = updated;
      return updated;
    });
  }

  async readCurrent(deploymentId: string): Promise<RuntimeDeploymentBootRecord | null> {
    this.validateDeploymentId(deploymentId);
    await this.serial;
    const state = await this.load();
    return structuredClone(state.deployments[deploymentId]?.[0] ?? null);
  }

  async readHistory(deploymentId: string): Promise<RuntimeDeploymentBootRecord[]> {
    this.validateDeploymentId(deploymentId);
    await this.serial;
    const state = await this.load();
    return structuredClone(state.deployments[deploymentId] ?? []);
  }

  private async mutate<T>(deploymentId: string, change: (history: RuntimeDeploymentBootRecord[]) => T): Promise<T> {
    this.validateDeploymentId(deploymentId);
    let result!: T;
    const operation = this.serial.then(async () => {
      const state = await this.load();
      const history = state.deployments[deploymentId] ?? [];
      result = change(history);
      state.deployments[deploymentId] = history;
      await this.persist(state);
    });
    this.serial = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return structuredClone(result);
  }

  private requireCurrent(history: RuntimeDeploymentBootRecord[], bootId: string): RuntimeDeploymentBootRecord {
    const current = history[0];
    if (!current || current.bootId !== bootId) {
      throw new RuntimeDeploymentLedgerError('runtime boot identity changed');
    }
    return current;
  }

  private validateDeploymentId(deploymentId: string): void {
    if (!deploymentIdSchema.safeParse(deploymentId).success) {
      throw new RuntimeDeploymentLedgerError('invalid deployment id');
    }
  }

  private async load(): Promise<RuntimeDeploymentLedgerState> {
    let raw: string;
    try {
      raw = await readFile(this.options.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { v: 1, installationId: this.options.installationId, deployments: {} };
      }
      throw new RuntimeDeploymentLedgerError('runtime deployment ledger is unreadable', { cause: error });
    }
    try {
      const parsed = stateSchema.parse(JSON.parse(raw));
      if (parsed.installationId !== this.options.installationId) {
        throw new RuntimeDeploymentLedgerError('runtime deployment ledger belongs to another installation');
      }
      return parsed;
    } catch (error) {
      if (error instanceof RuntimeDeploymentLedgerError) throw error;
      throw new RuntimeDeploymentLedgerError('runtime deployment ledger is malformed', { cause: error });
    }
  }

  private async persist(state: RuntimeDeploymentLedgerState): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 });
    const temp = `${this.options.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.options.file);
  }
}
