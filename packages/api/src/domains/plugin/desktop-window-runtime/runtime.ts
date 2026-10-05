import { WIRE_VERSION } from '@clowder-ai/plugin-contract';
import type { BuiltinPluginRuntime } from '../builtin-runtime/hybrid-supervisor.js';
import { startStaticSurfaceServer } from '../external-runtime/static-surface-server.js';
import type { VerifiedPluginPackage } from '../external-runtime/types.js';
import type { BuiltinBrokerConnection } from '../host-broker/builtin-loopback.js';
import { StaticFeatureAuthority } from '../host-broker/static-feature-authority.js';
import { desktopWindowContribution } from './admission.js';
import { unexpectedDesktopLossId } from './desktop-loss.js';
import { DesktopWindowObserver } from './observer.js';
import { resolveCompanionArchiveContract } from './published-companion-v2.js';
import type {
  ActiveWindow,
  DesktopWindowFailure,
  DesktopWindowPresence,
  DesktopWindowRuntimeOptions as Options,
} from './types.js';

/** One owner desktop body; observations are ephemeral, while installation, grants and leases remain in their stores. */
export class DesktopWindowPluginRuntime implements BuiltinPluginRuntime {
  readonly features: StaticFeatureAuthority;
  private active: ActiveWindow | undefined;
  private starting: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
  private readonly now: () => number;
  private readonly freshnessMs: number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.freshnessMs = Math.min(15_000, options.broker.activeRuntimeLeaseTtlMs);
    this.features = new StaticFeatureAuthority({
      inventory: options.inventory,
      store: options.brokerStore,
      broker: options.broker,
      admission: 'desktop-companion',
      now: this.now,
      verifyActivePackage: async (id, digest) => {
        const run = this.active;
        if (!run || run.id !== id || run.digest !== digest || run.closing)
          throw new Error('desktop package unavailable');
        await run.package.verifyIntegrity();
      },
    });
  }

  start(id: string): Promise<void> {
    if (this.active || this.starting) return Promise.reject(new Error('desktop body already has a runtime owner'));
    const controller = new AbortController();
    const promise = this.activate(id, controller).finally(() => {
      this.starting = undefined;
    });
    this.starting = { id, controller, promise };
    return promise;
  }

  async stop(id: string, reason: string): Promise<void> {
    if (this.starting?.id === id) {
      this.starting.controller.abort();
      await this.starting.promise.catch(() => undefined);
    }
    if (this.active?.id === id) await this.close(this.active, reason);
  }

  async presence(): Promise<DesktopWindowPresence | null> {
    const run = this.active;
    const observation = run?.observer?.observation;
    if (
      !run?.ready ||
      !observation ||
      !run.lease ||
      run.closing ||
      this.now() - observation.observedAt >= this.freshnessMs
    )
      return null;
    try {
      return await this.features.run(run.lease, async () =>
        this.active === run && run.ready && !run.closing && this.now() - observation.observedAt < this.freshnessMs
          ? structuredClone(observation)
          : null,
      );
    } catch {
      return null;
    }
  }

  async unexpectedLossId(): Promise<string | null> {
    return unexpectedDesktopLossId(await this.options.inventory.snapshot(), 'official.companion');
  }

  /** Revocation is cleanup, never an effect that can mint or renew authority. */
  async revokeMedia(): Promise<void> {
    if (this.starting) throw new Error('Desktop media teardown unconfirmed');
    const run = this.active;
    if (!run) return;
    if (run.closing) return run.closing;
    if (!run.window?.revokeMedia) throw new Error('Desktop media teardown unsupported');
    await run.window.revokeMedia();
  }

  async show(): Promise<void> {
    const run = this.active;
    if (!run?.ready || !run.observer || !run.lease || !(await this.presence()))
      throw new Error('desktop body unavailable');
    // Admit the send atomically with authority, but never hold a store transaction
    // while waiting for an OS process. A later close is ordered after this send.
    const admitted = await this.features.run(run.lease, async () => ({
      completion: run.window!.show().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    }));
    const result = await admitted.completion;
    if (!result.ok) throw result.error;
    try {
      await run.observer.observeAfterShow();
    } catch (error) {
      this.observationLost(run, error);
      throw error;
    }
  }

  private async activate(id: string, controller: AbortController): Promise<void> {
    let pkg: VerifiedPluginPackage | undefined;
    let connection: BuiltinBrokerConnection | undefined;
    try {
      const snapshot = await this.options.inventory.snapshot();
      const instance = snapshot.instances.find((r) => r.pluginInstanceId === id && r.lifecycleState === 'installed');
      const installed = instance && snapshot.packages.find((r) => r.packageDigest === instance.packageDigest);
      const contribution = installed && desktopWindowContribution(installed.manifest);
      if (!instance || !installed || !contribution) throw new Error('unsupported desktop companion');
      pkg = await this.options.packages.resolveInstalledPackage(instance.packageDigest);
      if (JSON.stringify(pkg.manifest) !== JSON.stringify(installed.manifest))
        throw new Error('desktop package authority mismatch');
      const companionContract = resolveCompanionArchiveContract(installed, this.options.companionArchives);
      if (installed.pluginId === 'official.companion' && !companionContract)
        throw new Error('companion archive contract unavailable');
      const publicCompanionV2 = companionContract !== undefined;
      controller.signal.throwIfAborted();
      connection = await this.options.broker.openBuiltinConnection(id);
      const run: ActiveWindow = {
        id,
        digest: instance.packageDigest,
        lifecycleRevision: instance.lifecycleRevision,
        package: pkg,
        connection,
        controller,
        ready: false,
      };
      this.active = run;
      const binding = await connection.hello({
        pluginId: pkg.manifest.pluginId,
        packageDigest: run.digest,
        contractVersion: pkg.manifest.contractVersion,
        wireVersion: WIRE_VERSION,
      });
      await connection.ready({ bindingNonce: binding.bindingNonce });
      const pending = await this.features.begin(id, pkg.manifest.features[0]!.id);
      run.lease = pending.executionLease;
      run.server = await startStaticSurfaceServer({
        package: pkg,
        contributions: [contribution],
        containment: { kind: 'desktop-companion' },
        isCurrent: async () => {
          if (this.active !== run || run.closing || controller.signal.aborted) return false;
          try {
            return await this.features.run(pending.executionLease, async () => true);
          } catch {
            return false;
          }
        },
        onFailure: () =>
          this.lost(run, { reason: 'surface-unavailable', exitCode: null, signal: null, initiator: 'surface' }),
      });
      await this.features.commit(pending.executionLease);
      run.bridge = this.options.createBridge?.({
        publicCompanionV2,
        ...(companionContract ? { companionContract } : {}),
        ...(this.options.disableCompanion ? { disableCompanion: () => this.disableActive(run) } : {}),
        assertCurrent: async () => {
          if (this.active !== run || run.closing || controller.signal.aborted) throw new Error('desktop ended');
          await this.features.run(pending.executionLease, async () => undefined);
        },
        navigate: async (url) => {
          if (!run.window?.navigate) return false;
          await this.features.run(pending.executionLease, async () => undefined);
          await run.window.navigate(url);
          return true;
        },
      });
      controller.signal.throwIfAborted();
      run.window = await this.options.executor.open({
        url: `${run.server.origin}${run.server.pathPrefix}${contribution.surface.entrypoint}`,
        presentation: contribution.presentation,
        ...(publicCompanionV2 ? { publicCompanionV2: true } : {}),
        ...(companionContract ? { companionContract } : {}),
        signal: controller.signal,
        onClosed: (failure) =>
          this.lost(run, {
            ...(failure ?? { reason: 'unknown', exitCode: null, signal: null }),
            initiator: 'executor',
          }),
        ...(run.bridge ? { request: (input: unknown) => run.bridge!.request(input) } : {}),
      });
      controller.signal.throwIfAborted();
      run.observer = new DesktopWindowObserver({
        id: run.id,
        window: run.window,
        lease: pending.executionLease,
        connection,
        features: this.features,
        freshnessMs: this.freshnessMs,
        now: this.now,
        isCurrent: () => this.active === run && !run.closing && !controller.signal.aborted,
      });
      await run.observer.observe();
      controller.signal.throwIfAborted();
      run.ready = true;
      run.observer.start((error) => this.observationLost(run, error));
    } catch (error) {
      if (this.active?.id === id) await this.close(this.active, 'desktop_start_failed');
      else {
        await connection?.close('desktop_start_failed');
        await pkg?.release();
      }
      throw error;
    }
  }

  private observationLost(run: ActiveWindow, error: unknown): void {
    this.lost(run, {
      reason:
        error instanceof Error && error.message === 'desktop heartbeat expired' ? 'heartbeat-expired' : 'poll-failed',
      exitCode: null,
      signal: null,
      initiator: 'host-observer',
    });
  }

  private lost(
    run: ActiveWindow,
    failure: DesktopWindowFailure = { reason: 'unknown', exitCode: null, signal: null },
  ): void {
    if (this.active !== run || run.closing) return;
    const observation = run.observer?.diagnostic();
    const firstFailure = observation ? { ...failure, observation } : failure;
    // Claim the first live terminal cause before aborting: the executor's
    // abort handler synchronously calls onClosed(undefined) back into lost().
    const wasReady = run.ready;
    run.ready = false;
    run.controller.abort();
    if (!wasReady) return; // activate owns cleanup while executor.open is pending.
    try {
      this.options.onFailure?.(run.id, firstFailure);
    } catch {
      // Reporting cannot prevent physical cleanup or the durable failed state.
    }
    void this.close(run, 'desktop_runtime_lost')
      .catch(() => undefined) // Cleanup failure must not erase the observed loss from inventory.
      .then(() =>
        this.options.inventory.transaction((tx) => {
          const current = tx.instances.get(run.id);
          if (
            current?.packageDigest === run.digest &&
            current.lifecycleRevision === run.lifecycleRevision &&
            current.activationState === 'enabled' &&
            !this.active
          ) {
            const occurredAt = this.now();
            tx.instances.put({
              ...current,
              runtimeState: 'crashed',
              updatedAt: occurredAt,
              lastRuntimeError: {
                code: 'UNEXPECTED_RUNTIME_FAILURE',
                desktopReason: failure.reason,
                exitCode: failure.exitCode,
                signal: failure.signal,
                occurredAt,
              },
            });
          }
        }),
      )
      .catch(() => undefined);
  }

  private close(run: ActiveWindow, reason: string): Promise<void> {
    run.ready = false;
    run.closing ??= this.closeRun(run, reason);
    return run.closing;
  }

  private async disableActive(run: ActiveWindow): Promise<void> {
    const disable = this.options.disableCompanion;
    if (this.active !== run || !run.ready || run.closing || !run.lease || !disable)
      throw new Error('Current companion unavailable');
    await this.features.run(run.lease, async () => undefined);
    const before = (await this.options.inventory.snapshot()).instances.find((row) => row.pluginInstanceId === run.id);
    if (before?.packageDigest !== run.digest || before.activationState !== 'enabled')
      throw new Error('Current companion changed');
    // Admit the fixed revision under this exact feature generation. Do not hold
    // a store transaction while lifecycle cleanup awaits the physical child.
    const admitted = await this.features.run(run.lease, async () => {
      if (this.active !== run || !run.ready || run.closing) throw new Error('Current companion changed');
      const completion = disable(run.id, before.lifecycleRevision);
      // The store may reject after work started; observe without changing the
      // original completion which the successful admission still awaits.
      void completion.catch(() => undefined);
      return { completion };
    });
    await admitted.completion;
    const after = (await this.options.inventory.snapshot()).instances.find((row) => row.pluginInstanceId === run.id);
    if (after?.packageDigest !== run.digest || after.activationState !== 'disabled' || this.active === run)
      throw new Error('Companion disable unconfirmed');
  }

  private async closeRun(run: ActiveWindow, reason: string): Promise<void> {
    try {
      await run.connection.close(reason); // Attempt the durable fence before child cleanup.
    } finally {
      // A failed store write must still stop the physical body. Its error is
      // propagated; cleanup is never reported as a successful durable revocation.
      run.controller.abort();
      run.observer?.stop();
      try {
        await Promise.all([run.window?.close(), run.bridge?.close()]);
      } finally {
        try {
          await run.server?.close();
        } finally {
          try {
            await run.package.release();
          } finally {
            if (this.active === run) this.active = undefined;
          }
        }
      }
    }
  }
}
