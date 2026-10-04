import { createHash, randomUUID } from 'node:crypto';
import type { CDPSession, Page } from 'puppeteer-core';
import {
  applyCdpPageChoice,
  type CdpPageActionSpec,
  type CdpPageTask,
  inspectCdpPageTask,
  performCdpPageTask,
  targetFingerprint,
  targetIdentityFingerprint,
  uniqueVisible,
} from './CdpPageBrowserTask.js';
import type { LivePageActionPort } from './LivePageAction.js';
import type { PageActionFence, PageActionFenceState, PageSnapshot } from './PageActionLoop.js';

export type { CdpPageActionSpec } from './CdpPageBrowserTask.js';

function frozenSpec(spec: CdpPageActionSpec): CdpPageActionSpec {
  if (
    spec.targets.length === 0 ||
    !spec.readback.selector ||
    new Set(spec.targets.map((target) => target.id)).size !== spec.targets.length ||
    spec.targets.some((target) => !target.id || !target.selector)
  )
    throw new Error('A page action port needs distinct Host-configured targets and canonical readback');
  return Object.freeze({
    targets: Object.freeze(spec.targets.map((target) => Object.freeze({ ...target }))),
    readback: Object.freeze({ ...spec.readback }),
  });
}

async function isolatedContext(session: CDPSession, nonce: string): Promise<number> {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const frameTree = await session.send('Page.getFrameTree');
  const world = await session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frameTree.frame.id,
    worldName: `cat-cafe-page-action-${nonce}`,
    grantUniveralAccess: false,
  });
  return world.executionContextId;
}

async function detachWithinDeadline(session: CDPSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('CDP session detach unconfirmed')), 100);
  });
  try {
    await Promise.race([session.detach(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function evaluateTask(session: CDPSession, contextId: number, task: CdpPageTask): Promise<unknown> {
  // Isolated-world helpers use __name in the tsx dev transform.
  const actor = task.mode === 'inspect' ? inspectCdpPageTask : performCdpPageTask;
  const expression = `(() => {
    const __name = (fn) => fn;
    const uniqueVisible = ${uniqueVisible.toString()};
    const targetFingerprint = ${targetFingerprint.toString()};
    const targetIdentityFingerprint = ${targetIdentityFingerprint.toString()};
    const applyCdpPageChoice = ${applyCdpPageChoice.toString()};
    return (${actor.toString()})(${JSON.stringify(task)});
  })()`;
  const evaluated = await session.send('Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error('Browser page action task raised an exception');
  return evaluated.result.value;
}

function isSnapshot(value: unknown): value is PageSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    typeof value.url === 'string' &&
    'origin' in value &&
    typeof value.origin === 'string' &&
    'readback' in value &&
    typeof value.readback === 'string' &&
    'candidates' in value &&
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (candidate: unknown) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'id' in candidate &&
        typeof candidate.id === 'string' &&
        'operation' in candidate &&
        (candidate.operation === 'click' || candidate.operation === 'fill') &&
        'label' in candidate &&
        typeof candidate.label === 'string' &&
        'fingerprint' in candidate &&
        typeof candidate.fingerprint === 'string' &&
        candidate.fingerprint.length <= 65_536,
    )
  );
}

function opaqueFingerprint(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

async function resolveCommitFence(
  payload: string,
  nonce: string,
  expectedFingerprint: string,
  fence: PageActionFence,
): Promise<PageActionFenceState | 'stale'> {
  let offered: unknown;
  try {
    offered = JSON.parse(payload);
  } catch {
    return 'denied';
  }
  if (
    typeof offered !== 'object' ||
    offered === null ||
    !('nonce' in offered) ||
    offered.nonce !== nonce ||
    !('fingerprint' in offered) ||
    typeof offered.fingerprint !== 'string' ||
    offered.fingerprint.length > 65_536
  )
    return 'denied';
  if (opaqueFingerprint(offered.fingerprint) !== expectedFingerprint) return 'stale';
  try {
    return await fence();
  } catch {
    return 'denied';
  }
}

/** Uses a Host-approved Puppeteer page; this module never attaches to a browser or grants access. */
export function createCdpPageActionPort(page: Page, sourceSpec: CdpPageActionSpec): LivePageActionPort {
  const spec = frozenSpec(sourceSpec);
  // A grant issued from this actor must not authorize an identically shaped node in a rebuilt actor.
  const actorId = randomUUID().replaceAll('-', '');
  let opened: Promise<{ session: CDPSession; contextId: number }> | undefined;
  let activeSession: CDPSession | undefined;
  let closed = false;
  const context = () => {
    if (closed) throw new Error('Page action port is closed');
    opened ??= (async () => {
      const session = await page.createCDPSession();
      if (closed) {
        void detachWithinDeadline(session).catch(() => undefined);
        throw new Error('Page action port closed before CDP session creation');
      }
      activeSession = session;
      try {
        const contextId = await isolatedContext(session, actorId);
        if (closed) throw new Error('Page action port closed during CDP setup');
        return { session, contextId };
      } catch (error) {
        void detachWithinDeadline(session).catch(() => undefined);
        throw error;
      }
    })();
    return opened;
  };
  return {
    async inspect() {
      const { session, contextId } = await context();
      if (closed) throw new Error('Page action port closed before inspection');
      const result = await evaluateTask(session, contextId, { mode: 'inspect', spec, actorId });
      if (closed) throw new Error('Page action port closed during inspection');
      if (!isSnapshot(result)) throw new Error('Browser inspection did not return a page snapshot');
      return {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          ...candidate,
          fingerprint: opaqueFingerprint(candidate.fingerprint),
        })),
      };
    },
    async perform(choice, fingerprint, url, _requestRevision, fence) {
      const { session, contextId } = await context();
      if (closed) throw new Error('Page action port closed before commit');
      const nonce = randomUUID().replaceAll('-', '');
      const bindingName = `__catCafeActionFence_${nonce}`;
      const resolverName = `__catCafeActionResolve_${nonce}`;
      await session.send('Runtime.addBinding', { name: bindingName, executionContextId: contextId });
      if (closed) throw new Error('Page action port closed during commit setup');
      const onBindingCalled = (event: { name: string; payload: string; executionContextId: number }) => {
        if (closed || event.name !== bindingName || event.executionContextId !== contextId) return;
        void (async () => {
          const state = await resolveCommitFence(event.payload, nonce, fingerprint, fence);
          if (closed) return;
          await session.send('Runtime.evaluate', {
            expression: `globalThis[${JSON.stringify(resolverName)}](${JSON.stringify(state)})`,
            contextId,
            returnByValue: true,
          });
        })().catch(() => {
          // A broken reply channel cannot grant an effect. Detach rejects
          // the waiting browser task; the caller reports unknown.
          void session.detach().catch(() => undefined);
        });
      };
      session.on('Runtime.bindingCalled', onBindingCalled);
      try {
        const task = {
          mode: 'perform' as const,
          spec,
          actorId,
          choice,
          fingerprint,
          url,
          bindingName,
          resolverName,
          nonce,
        };
        const outcome = await evaluateTask(session, contextId, task);
        if (
          outcome === 'applied' ||
          outcome === 'stale' ||
          outcome === 'cancelled' ||
          outcome === 'changed_request' ||
          outcome === 'denied'
        )
          return outcome;
        throw new Error('Browser action task returned an invalid outcome');
      } finally {
        session.off('Runtime.bindingCalled', onBindingCalled);
      }
    },
    async close() {
      closed = true;
      void opened?.catch(() => undefined);
      if (activeSession) await detachWithinDeadline(activeSession);
    },
  };
}
