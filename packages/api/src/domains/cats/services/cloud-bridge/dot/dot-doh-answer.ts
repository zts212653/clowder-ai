import { isIP } from 'node:net';
import { z } from 'zod';

const name = z.string().min(1).max(254);
const answer = z.object({ name, type: z.number().int(), data: z.string().max(1024) });
const result = z.object({
  Status: z.literal(0),
  TC: z.literal(false),
  Question: z.array(z.object({ name, type: z.number().int() })).length(1),
  Answer: z.array(answer).max(32).optional().default([]),
});
const normalize = (value: string) => value.toLowerCase().replace(/\.$/, '');
type Answer = z.infer<typeof answer>;

function validateAddressRecords(records: Answer[], type: 1 | 28) {
  for (const record of records) {
    if (record.type !== 1 && record.type !== 28) continue;
    if (record.type !== type || isIP(record.data) !== (type === 1 ? 4 : 6))
      throw new Error('callback_dns_invalid_address');
  }
}

function chainStep(records: Answer[], current: string, type: 1 | 28, visited: Set<string>) {
  const matching = records.filter((r) => normalize(r.name) === current);
  const aliases = matching.filter((r) => r.type === 5);
  const addresses = matching.filter((r) => r.type === type);
  if (aliases.length > 1 || (aliases.length && addresses.length)) throw new Error('callback_dns_incomplete_answer');
  if (aliases.length) {
    const next = normalize(aliases[0]?.data ?? '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(next))
      throw new Error('callback_dns_incomplete_answer');
    return { next };
  }
  // A complete NOERROR/TC=false recursive answer may end a CNAME chain in NODATA.
  // Both families are still queried and the sender refuses a combined empty set.
  if (records.some((r) => (r.type === type || r.type === 5) && !visited.has(normalize(r.name))))
    throw new Error('callback_dns_incomplete_answer');
  return { addresses: addresses.map((r) => r.data) };
}

/** Consume only a complete, bounded chain for this exact question; validate IP text before CONNECT. */
export function dotDohAddresses(hostname: string, type: 1 | 28, input: unknown): string[] {
  const parsed = result.safeParse(input);
  if (!parsed.success) throw new Error('callback_dns_invalid_response');
  const { Question, Answer } = parsed.data;
  if (normalize(Question[0]?.name ?? '') !== normalize(hostname) || Question[0]?.type !== type)
    throw new Error('callback_dns_invalid_response');
  validateAddressRecords(Answer, type);
  const visited = new Set<string>();
  let current = normalize(hostname);
  for (let depth = 0; depth <= 8; depth++) {
    if (visited.has(current)) throw new Error('callback_dns_incomplete_answer');
    visited.add(current);
    const step = chainStep(Answer, current, type, visited);
    if (step.addresses) return step.addresses;
    current = step.next;
  }
  throw new Error('callback_dns_incomplete_answer');
}
