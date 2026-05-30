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
  it('formats epoch-ms as "HH:mm UTC" with an explicit timezone marker', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 6, 40, 0, 0)), '06:40 UTC');
  });

  it('uses UTC base, NOT host-local (a PDT host would render this instant as 20:00 prev day)', async () => {
    const { formatPromptTime } = await load();
    // 03:00 UTC — the exact instant from PR #793. getHours() on a UTC-7 host
    // would return 20:00 (previous day); asserting 03:00 proves UTC base.
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 3, 0, 0, 0)), '03:00 UTC');
  });

  it('zero-pads single-digit hours and minutes', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 3, 5, 0, 0)), '03:05 UTC');
  });

  it('handles the midnight boundary', async () => {
    const { formatPromptTime } = await load();
    assert.equal(formatPromptTime(Date.UTC(2026, 4, 29, 0, 0, 0, 0)), '00:00 UTC');
  });
});

describe('format-time — formatPromptTimeRange', () => {
  it('renders a from–to range with a single trailing UTC marker', async () => {
    const { formatPromptTimeRange } = await load();
    const from = Date.UTC(2026, 4, 29, 6, 40, 0, 0);
    const to = Date.UTC(2026, 4, 29, 7, 5, 0, 0);
    assert.equal(formatPromptTimeRange(from, to), '06:40 — 07:05 UTC');
  });

  it('range endpoints use UTC base', async () => {
    const { formatPromptTimeRange } = await load();
    const from = Date.UTC(2026, 4, 29, 0, 0, 0, 0);
    const to = Date.UTC(2026, 4, 29, 23, 59, 0, 0);
    assert.equal(formatPromptTimeRange(from, to), '00:00 — 23:59 UTC');
  });
});
