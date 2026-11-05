import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Durations are inclusive. Never sum nested or parallel spans to infer user latency. */
export function summarizeSave(records, traceId) {
  const selected = records.filter((r) => r.event === 'member_save' && r.traceId === traceId);
  const spans = new Map(),
    browser = new Map();
  for (const record of selected) {
    if (record.source === 'browser') {
      browser.set(record.seq, record);
      continue;
    }
    if (typeof record.spanId !== 'number') continue;
    const key = `${record.pid}:${record.requestId}:${record.spanId}`;
    const span = spans.get(key) ?? {
      requestId: record.requestId,
      clientRequestId: record.clientRequestId,
      spanId: record.spanId,
      parentSpanId: record.parentSpanId,
      phase: record.phase,
      catId: record.catId,
      route: record.route,
      background: record.background,
      state: 'incomplete',
      startSeen: false,
    };
    if (record.state === 'start') span.startSeen = true;
    if (['finish', 'failed', 'aborted'].includes(record.state)) {
      Object.assign(span, { state: record.state, durationMs: record.durationMs, statusCode: record.statusCode });
    }
    if (record.state === 'slow')
      span.lastSlow = { durationMs: record.durationMs, active: record.active, timerLagMs: record.timerLagMs };
    spans.set(key, span);
  }
  const browserEvents = [...browser.values()]
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq, phase, state, elapsedMs, durationMs, clientRequestId, attempt, statusCode, errorKind }) => ({
      seq,
      phase,
      state,
      elapsedMs,
      durationMs,
      clientRequestId,
      attempt,
      statusCode,
      errorKind,
    }));
  return {
    traceId,
    revisions: [...new Set(selected.map((r) => r.revision).filter(Boolean))],
    browserEvidence: browserEvents.length
      ? 'received (client-reported timing)'
      : 'missing; server timing alone cannot explain click-to-completion',
    save:
      browserEvents.findLast((r) => r.phase === 'save' && ['finish', 'failed', 'aborted'].includes(r.state)) ?? null,
    uiCommit: browserEvents.findLast((r) => r.phase === 'ui.commit') ?? null,
    changedFields: [...new Set(selected.flatMap((r) => (r.phase === 'request.fields' ? (r.fields ?? []) : [])))],
    foreground: [...spans.values()].filter((r) => !r.background),
    background: [...spans.values()].filter((r) => r.background),
    browserEvents,
    note: 'Inclusive timings overlap. Incomplete = no terminal event in supplied logs, not proof of a hang. Check log coverage and process restarts.',
  };
}

async function main() {
  const { values } = parseArgs({ options: { log: { type: 'string', multiple: true }, trace: { type: 'string' } } });
  if (!values.log?.length)
    throw new Error(
      'Usage: node scripts/analyze-member-save.mjs --log <api.log> [--log <another.log>] [--trace <uuid>]',
    );
  const records = [],
    latest = new Map();
  for (const file of values.log) {
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.event !== 'member_save') continue;
      if (values.trace) {
        if (record.traceId === values.trace) records.push(record);
      } else {
        const entries = latest.get(record.traceId) ?? [];
        entries.push(record);
        if (entries.length > 5000) entries.shift();
        latest.delete(record.traceId);
        latest.set(record.traceId, entries);
        if (latest.size > 10) latest.delete(latest.keys().next().value);
      }
    }
  }
  const ids = values.trace ? [values.trace] : [...latest.keys()];
  console.log(
    JSON.stringify(
      ids.map((id) => summarizeSave(values.trace ? records : latest.get(id), id)),
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
