import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { trajectoryCopy } from './trajectory.shell-copy';
import { useTrajectoryCopy } from './use-trajectory-copy';

interface SourcePage {
  eventNo: number;
  text: string;
  nextEventNo?: number;
  nextCharOffset?: number;
}
type Source = NonNullable<InvocationTrajectorySummary['firstAssistantOutputEvidence']>['source'];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

async function readSlice(url: string, eventNo: number, charOffset: number): Promise<SourcePage> {
  const response = await apiFetch(`${url}&charOffset=${charOffset}`);
  if (!response.ok) throw new Error('Source unavailable');
  const body = record(await response.json());
  if (
    body?.eventNo !== eventNo ||
    body.charOffset !== charOffset ||
    typeof body.eventSlice !== 'string' ||
    typeof body.totalChars !== 'number' ||
    !Number.isSafeInteger(body.totalChars) ||
    !body.eventSlice.length ||
    body.eventSlice.length > 8000 ||
    charOffset + body.eventSlice.length > body.totalChars ||
    (body.nextCharOffset !== undefined
      ? body.nextCharOffset !== charOffset + body.eventSlice.length || body.nextCharOffset >= body.totalChars
      : charOffset + body.eventSlice.length !== body.totalChars)
  )
    throw new Error('Source slice mismatch');
  return {
    eventNo,
    text: body.eventSlice,
    ...(typeof body.nextCharOffset === 'number' ? { nextCharOffset: body.nextCharOffset } : {}),
  };
}

async function readSourcePage(
  url: string,
  eventNo: number,
  summary: InvocationTrajectorySummary,
  source: Source,
): Promise<SourcePage> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error('Source unavailable');
  const body = record(await response.json());
  const event = record(Array.isArray(body?.events) ? body.events[0] : undefined);
  if (
    event?.eventNo !== eventNo ||
    event.invocationId !== summary.invocationId ||
    (event.sessionId !== undefined && event.sessionId !== summary.sessionId)
  )
    throw new Error('Source mismatch');
  if (event.oversized !== true && !record(event.event)) throw new Error('Source payload unavailable');
  const next =
    event.oversized === true
      ? await readSlice(url, eventNo, 0)
      : ({ eventNo, text: JSON.stringify(event.event, null, 2) } as SourcePage);
  const cursor = record(body?.nextCursor)?.eventNo;
  if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > eventNo && cursor <= source.lastEventNo) {
    next.nextEventNo = cursor;
  }
  return next;
}

export function FirstOutputSource({ summary }: { summary: InvocationTrajectorySummary }) {
  const source = summary.firstAssistantOutputEvidence?.source;
  if (
    !source ||
    source.sessionId !== summary.sessionId ||
    source.invocationId !== summary.invocationId ||
    !Number.isSafeInteger(source.firstEventNo) ||
    source.firstEventNo < 0 ||
    !Number.isSafeInteger(source.lastEventNo) ||
    source.lastEventNo < source.firstEventNo
  )
    return null;
  return (
    <SourceReader
      key={`${source.sessionId}:${source.invocationId}:${source.firstEventNo}:${source.lastEventNo}`}
      summary={summary}
    />
  );
}

function SourceReader({ summary }: { summary: InvocationTrajectorySummary }) {
  const source = summary.firstAssistantOutputEvidence?.source;
  const t = useTrajectoryCopy(trajectoryCopy);
  const [page, setPage] = useState<SourcePage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    return () => {
      request.current += 1;
    };
  }, []);
  if (!source) return null;

  async function load(eventNo: number, charOffset?: number) {
    if (!source || eventNo < source.firstEventNo || eventNo > source.lastEventNo) return;
    const attempt = ++request.current;
    setLoading(true);
    setError(false);
    const url = `/api/sessions/${encodeURIComponent(summary.sessionId)}/events?view=raw&cursor=${eventNo}&limit=1`;
    try {
      let next: SourcePage;
      if (charOffset !== undefined) {
        next = { ...(await readSlice(url, eventNo, charOffset)), nextEventNo: page?.nextEventNo };
      } else {
        next = await readSourcePage(url, eventNo, summary, source);
      }
      if (attempt === request.current) setPage(next);
    } catch {
      if (attempt === request.current) {
        setPage(undefined);
        setError(true);
      }
    } finally {
      if (attempt === request.current) setLoading(false);
    }
  }
  return (
    <div className="mb-2 min-w-0 text-micro text-cafe-muted" data-testid="first-output-source">
      <button
        type="button"
        disabled={loading}
        onClick={() => void load(source.firstEventNo)}
        className="rounded px-1 py-1 underline focus-visible:outline"
      >
        {t.viewFirst}
      </button>
      {loading && <output className="block">{t.firstLoading}</output>}
      {error && <p role="alert">{t.firstFailed}</p>}
      {page && (
        <div>
          <p>{t.sourceRecord(page.eventNo)}</p>
          <pre className="max-h-48 overflow-auto rounded bg-cafe-surface p-2 text-cafe-secondary">{page.text}</pre>
          {page.nextCharOffset !== undefined ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(page.eventNo, page.nextCharOffset)}
              className="mt-1 rounded px-1 py-1 underline focus-visible:outline"
            >
              {t.continueRecord}
            </button>
          ) : (
            page.nextEventNo !== undefined && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(page.nextEventNo as number)}
                className="mt-1 rounded px-1 py-1 underline focus-visible:outline"
              >
                {t.nextSource}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
