import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OwnerPageAction, OwnerPageActionProfile } from '../../live/host/owner-page-action-contract.js';
import { type createJevPageSelector, JevSelectionNotice } from './JevPageSelector.js';

const EXCLUDED_PORTS = new Set([3001, 3002, 3003, 3011, 3012, 4111, 6397, 6398, 6399]);
const localUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        Number(url.port) >= 1024 &&
        !EXCLUDED_PORTS.has(Number(url.port)) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Exact permitted loopback URL required');
export const browserEndpointSchema = localUrl.refine((value) => new URL(value).pathname === '/');
const selector = z.string().regex(/^#[a-zA-Z][a-zA-Z0-9_-]{0,127}$/);
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/);
const target = z.discriminatedUnion('operation', [
  z.object({ id, selector, operation: z.literal('click'), expectedReadback: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      id,
      selector,
      operation: z.literal('fill'),
      expectedReadbackTemplate: z
        .string()
        .max(4096)
        .refine((value) => value.split('{value}').length === 2),
    })
    .strict(),
]);

/** Operator configuration is a named page grant, not an HTTP/model-selected URL or selector. */
export const pageConfigSchema = z
  .object({
    profileId: id,
    pageUrl: localUrl,
    browserURL: browserEndpointSchema,
    allowJevProjection: z.literal(true),
    targets: z
      .array(target)
      .min(1)
      .max(32)
      .refine(
        (items) =>
          new Set(items.map((item) => item.id)).size === items.length &&
          new Set(items.map((item) => item.selector)).size === items.length,
      ),
    readback: z.object({ selector, kind: z.enum(['text', 'value']) }).strict(),
  })
  .strict();
export type ConfiguredPage = z.infer<typeof pageConfigSchema>;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function createConfiguredJevPageProfile(
  raw: unknown,
  provider: ReturnType<typeof createJevPageSelector>,
): OwnerPageActionProfile {
  const config = pageConfigSchema.parse(raw);
  // Plans are private, request-bound decisions. They confer no authority without the existing owner ledger.
  const selections = new WeakMap<
    OwnerPageAction,
    { requestHash: string; choice: Awaited<ReturnType<typeof provider.select>>['choice'] }
  >();
  return {
    profileId: config.profileId,
    url: config.pageUrl,
    spec: {
      targets: config.targets.map(({ id, selector, operation }) => ({ id, selector, operation })),
      readback: config.readback,
    },
    restoreAfterAction: false,
    async prepare(snapshot, request) {
      if (
        !request ||
        request.signal.aborted ||
        snapshot.url !== config.pageUrl ||
        snapshot.origin !== new URL(config.pageUrl).origin ||
        snapshot.candidates.some(
          (candidate) =>
            !config.targets.some((item) => item.id === candidate.id && item.operation === candidate.operation),
        )
      )
        throw new Error('Configured page request unavailable');
      const selection = await provider.select({
        utterance: request.utterance,
        candidates: snapshot.candidates,
        signal: request.signal,
      });
      if (request.signal.aborted) throw new Error('Jev selection cancelled');
      if (selection.choice.kind !== 'act') throw new JevSelectionNotice(selection.choice, selection.receipt);
      const choice = selection.choice;
      const selected = snapshot.candidates.find(
        (item) => item.id === choice.targetId && item.operation === choice.operation,
      );
      const policy = config.targets.find((item) => item.id === choice.targetId && item.operation === choice.operation);
      if (!selected || !policy || (policy.operation === 'fill' && typeof choice.value !== 'string'))
        throw new Error('Jev choice outside named page policy');
      const ownerValue = choice.value;
      const expectedReadback =
        policy.operation === 'click'
          ? policy.expectedReadback
          : policy.expectedReadbackTemplate.replace('{value}', () =>
              typeof ownerValue === 'string' ? ownerValue : '',
            );
      const action: OwnerPageAction = Object.freeze({
        targetId: selected.id,
        operation: selected.operation,
        ...(choice.value === undefined ? {} : { value: choice.value }),
        fingerprint: selected.fingerprint,
        expectedReadback,
      });
      selections.set(action, { requestHash: hash(request.utterance), choice: { ...choice } });
      return {
        profileId: config.profileId,
        url: config.pageUrl,
        origin: snapshot.origin,
        beforeReadback: snapshot.readback,
        action,
        selection: selection.receipt,
        consent: {
          pageUrl: config.pageUrl,
          field: selected.label,
          ...(choice.value === undefined ? {} : { value: choice.value }),
        },
      };
    },
    rollback() {
      throw new Error('Product actions persist; restoration needs a new owner request');
    },
    selector(action) {
      const selection = selections.get(action);
      if (!selection) throw new Error('Jev decision unavailable');
      return {
        async select({ utterance, candidates, signal }) {
          const target = candidates.find((item) => item.id === action.targetId && item.operation === action.operation);
          if (signal.aborted || hash(utterance) !== selection.requestHash || target?.fingerprint !== action.fingerprint)
            return { kind: 'none', reason: 'Jev decision is no longer current' };
          return { ...selection.choice };
        },
      };
    },
  };
}
