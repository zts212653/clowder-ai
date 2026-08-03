import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ─── Bug: timezone-inconsistent prompt timestamps ────────────────────
//
// Symptom: timestamps injected into agent prompts used three inconsistent
//   formats — nav card `toISOString().slice(11,16)` (UTC, no marker),
//   dialog history `getHours()/getMinutes()` (host-local, no marker),
//   and time ranges `toLocaleTimeString('en-US')` (host-local). The same
//   instant rendered as `06:40` (UTC) on the nav card and `23:40` (PDT) in
//   the dialog stream — a 7h gap, neither tagged with a timezone. Cats
//   could not align prompt timestamps with external UTC timestamps
//   (GitHub, verdict IDs, cron logs).
//
// Fix: a single shared formatter — UTC base + explicit "UTC" marker — used
//   by every prompt-facing call site.

const load = () => import('../dist/domains/cats/services/format-time.js');

describe('format-time — formatPromptTime (UTC-consistent prompt timestamps)', () => {
  it('formats epoch-ms with a UTC date, time, and explicit timezone marker', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 6, 40, 0, 0), { timeZone: null }), '2026-05-29 06:40 UTC');
  });

  it('formats co-creator local time plus UTC when an IANA timezone is configured', async () => {
    const { formatPromptTime } = await load();
    assert.equal(
      formatPromptTime(Date.UTC(2026, 5, 1, 6, 20, 0, 0), { timeZone: 'America/Los_Angeles' }),
      'co-creator本地 2026-05-31 23:20 America/Los_Angeles / 2026-06-01 06:20 UTC',
    );
  });

  it('keeps UTC-only output by default while still preserving the date', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 5, 1, 6, 20, 0, 0)), '2026-06-01 06:20 UTC');
  });

  it('uses UTC base, NOT host-local (a PDT host would render this instant as 20:00 prev day)', async () => {
    const { formatPromptTime } = await load();
    // 03:00 UTC — the exact instant from PR #793. getHours() on a UTC-7 host
    // would return 20:00 (previous day); asserting 03:00 proves UTC base.
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 3, 0, 0, 0), { timeZone: null }), '2026-05-29 03:00 UTC');
  });

  it('zero-pads single-digit hours and minutes', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 3, 5, 0, 0), { timeZone: null }), '2026-05-29 03:05 UTC');
  });

  it('handles the midnight boundary', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 0, 0, 0, 0), { timeZone: null }), '2026-05-29 00:00 UTC');
  });

  it('keeps local and UTC dates distinct during the Pacific/UTC cross-day window', async () => {
    const { formatPromptTime } = await load();
    assert.equal(
      formatPromptTime(Date.UTC(2026, 6, 6, 3, 14, 0, 0), { timeZone: 'America/Los_Angeles' }),
      'co-creator本地 2026-07-05 20:14 America/Los_Angeles / 2026-07-06 03:14 UTC',
    );
  });

  it('can append an age computed by the harness against an invocation now', async () => {
    const { formatPromptTime } = await load();
    assert.equal(
      formatPromptTime(Date.UTC(2026, 6, 5, 14, 56, 0, 0), {
        nowMs: Date.UTC(2026, 6, 5, 23, 55, 0, 0),
        includeAge: 'always',
      }),
      '2026-07-05 14:56 UTC · 8h59m ago',
    );
  });

  it('can compare stale dates in co-creator local time while keeping UTC-only output compact', async () => {
    const { formatPromptTime } = await load();
    assert.equal(
      formatPromptTime(Date.UTC(2026, 6, 5, 23, 50, 0, 0), {
        nowMs: Date.UTC(2026, 6, 6, 3, 30, 0, 0),
        includeAge: 'stale',
        staleComparisonTimeZone: 'America/Los_Angeles',
      }),
      '2026-07-05 23:50 UTC',
    );
  });
});

describe('format-time — formatPromptTimeRange', () => {
  it('renders a from–to range with dated UTC endpoints', async () => {
    const { formatPromptTimeRange } = await load();
    const from = Date.UTC(2026, 4, 29, 6, 40, 0, 0);
    const to = Date.UTC(2026, 4, 29, 7, 5, 0, 0);
    assert.equal(formatPromptTimeRange(from, to, { timeZone: null }), '2026-05-29 06:40 — 2026-05-29 07:05 UTC');
  });

  it('renders local and UTC range when an IANA timezone is configured', async () => {
    const { formatPromptTimeRange } = await load();
    const from = Date.UTC(2026, 5, 1, 6, 20, 0, 0);
    const to = Date.UTC(2026, 5, 1, 7, 5, 0, 0);
    assert.equal(
      formatPromptTimeRange(from, to, { timeZone: 'America/Los_Angeles' }),
      'co-creator本地 2026-05-31 23:20 — 2026-06-01 00:05 America/Los_Angeles / 2026-06-01 06:20 — 2026-06-01 07:05 UTC',
    );
  });

  it('range endpoints use UTC base', async () => {
    const { formatPromptTimeRange } = await load();
    const from = Date.UTC(2026, 4, 29, 0, 0, 0, 0);
    const to = Date.UTC(2026, 4, 29, 23, 59, 0, 0);
    assert.equal(formatPromptTimeRange(from, to, { timeZone: null }), '2026-05-29 00:00 — 2026-05-29 23:59 UTC');
  });
});
