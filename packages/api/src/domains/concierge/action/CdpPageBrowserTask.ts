import type { PageChoice, PageOperation, PageSnapshot } from './PageActionLoop.js';

// The API compiles against Node libraries. Only these browser globals are used
// by the serialized isolated-world tasks; DOM lib must not enter the API build.
interface BrowserElement {
  readonly tagName: string;
  readonly outerHTML: string;
  readonly textContent: string | null;
  value?: string;
  getClientRects(): { length: number };
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  click?(): void;
  dispatchEvent(event: Event): boolean;
}
declare const document: { querySelectorAll(selector: string): ArrayLike<BrowserElement> };
declare const location: { origin: string; href: string };

export interface CdpPageActionSpec {
  readonly targets: readonly { id: string; selector: string; operation: PageOperation }[];
  readonly readback: { selector: string; kind: 'text' | 'value' };
}
export type InspectTask = { mode: 'inspect'; spec: CdpPageActionSpec; actorId: string };
export type PerformTask = {
  mode: 'perform';
  spec: CdpPageActionSpec;
  actorId: string;
  choice: Extract<PageChoice, { kind: 'act' }>;
  fingerprint: string;
  url: string;
  bindingName: string;
  resolverName: string;
  nonce: string;
};
export type CdpPageTask = InspectTask | PerformTask;

/** Serialized with the task. No closure or page-owned JavaScript is trusted. */
export function uniqueVisible(selector: string): BrowserElement | null {
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1 || !matches[0]) return null;
  const element = matches[0];
  if (element.getClientRects().length === 0 || element.matches(':disabled')) return null;
  return element;
}

export function targetFingerprint(element: BrowserElement): string {
  return JSON.stringify([
    element.tagName,
    element.outerHTML,
    element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ? element.value : null,
  ]);
}

export function targetIdentityFingerprint(element: BrowserElement, issue: boolean, actorId: string): string | null {
  const world = globalThis as unknown as Record<string, unknown>;
  type IdentityStore = { nodes: WeakMap<object, string>; next: number };
  let store = world.__catCafeActionNodeIdentities as IdentityStore | undefined;
  if (!store) {
    if (!issue) return null;
    store = { nodes: new WeakMap<object, string>(), next: 0 };
    world.__catCafeActionNodeIdentities = store;
  }
  let token = store.nodes.get(element);
  if (!token && issue) {
    token = String(++store.next);
    store.nodes.set(element, token);
  }
  return token ? JSON.stringify([actorId, token, targetFingerprint(element)]) : null;
}

export function applyCdpPageChoice(
  element: BrowserElement,
  choice: Extract<PageChoice, { kind: 'act' }>,
): 'applied' | 'stale' {
  if (choice.operation === 'click') {
    if (typeof element.click !== 'function') return 'stale';
    element.click();
    return 'applied';
  }
  if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && typeof choice.value === 'string') {
    element.value = choice.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return 'applied';
  }
  return 'stale';
}

export function inspectCdpPageTask(input: InspectTask): PageSnapshot {
  const readbackElement = uniqueVisible(input.spec.readback.selector);
  if (!readbackElement) throw new Error('Canonical readback unavailable or ambiguous');
  const readback =
    input.spec.readback.kind === 'value'
      ? readbackElement.tagName === 'INPUT' || readbackElement.tagName === 'TEXTAREA'
        ? readbackElement.value
        : null
      : readbackElement.textContent;
  if (typeof readback !== 'string') throw new Error('Canonical readback kind mismatches the element');
  return {
    origin: location.origin,
    url: location.href,
    readback,
    candidates: input.spec.targets.flatMap((target) => {
      const element = uniqueVisible(target.selector);
      if (!element) return [];
      const fingerprint = targetIdentityFingerprint(element, true, input.actorId);
      if (!fingerprint) return [];
      const label = element.getAttribute('aria-label') || element.textContent?.trim() || '';
      return [{ id: target.id, operation: target.operation, label, fingerprint }];
    }),
  };
}

export async function performCdpPageTask(
  input: PerformTask,
): Promise<'applied' | 'stale' | 'denied' | 'cancelled' | 'changed_request'> {
  // The binding exists only in this isolated context. No await follows permit.
  const world = globalThis as unknown as Record<string, unknown>;
  const binding = world[input.bindingName];
  if (typeof binding !== 'function') throw new Error('Host commit fence unavailable');
  if (location.href !== input.url) return 'stale';
  const target = input.spec.targets.find(
    (entry) => entry.id === input.choice.targetId && entry.operation === input.choice.operation,
  );
  if (!target) return 'denied';
  const before = uniqueVisible(target.selector);
  if (!before) return 'stale';
  const beforeFingerprint = targetIdentityFingerprint(before, false, input.actorId);
  if (!beforeFingerprint) return 'stale';
  const state = await new Promise<string>((resolve) => {
    world[input.resolverName] = resolve;
    binding(JSON.stringify({ nonce: input.nonce, fingerprint: beforeFingerprint }));
  });
  delete world[input.resolverName];
  if (state !== 'current') {
    if (state === 'cancelled' || state === 'changed_request' || state === 'denied' || state === 'stale') return state;
    return 'denied';
  }
  if (location.href !== input.url) return 'stale';
  const element = uniqueVisible(target.selector);
  if (!element || targetIdentityFingerprint(element, false, input.actorId) !== beforeFingerprint) return 'stale';
  return applyCdpPageChoice(element, input.choice);
}
