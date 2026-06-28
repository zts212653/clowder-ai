/**
 * F168 Phase D — D5 Closure UX Components (RED tests)
 *
 * TDD: These tests describe the expected behavior of ClosureChecklistCard,
 * ReconciliationFindingCard, and WaiverAuditForm BEFORE implementation.
 *
 * Invariants under test:
 *   INV-D6.1: Close action disabled until checklist ready or waiver exists
 *   INV-D6.2: Waive action always opens audit form; no one-click waive
 *   INV-D6.3: UI must show evidence source rather than only green/red badge
 *   INV-D6.4: Frontend uses SVG icons only, no emoji (KD-9)
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) => selector({}),
}));

import { ClosureChecklistCard } from '@/components/community/ClosureChecklistCard';
import { ReconciliationFindingCard } from '@/components/community/ReconciliationFindingCard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHECKLIST_BLOCKED = {
  readyToClose: false,
  blockers: [{ kind: 'fixed-not-reported' as const, detail: 'Fix merged but not reported to author' }],
  waiverPresent: false,
};

const CHECKLIST_READY = {
  readyToClose: true,
  blockers: [],
  waiverPresent: false,
};

const CHECKLIST_WAIVED = {
  readyToClose: false,
  blockers: [{ kind: 'fixed-not-reported' as const, detail: 'Fix merged but not reported to author' }],
  waiverPresent: true,
};

const CHECKLIST_NOT_CLOSEABLE = {
  readyToClose: false,
  blockers: [{ kind: 'not-in-closeable-state' as const, detail: 'Issue is not in a closeable state' }],
  waiverPresent: false,
};

const MOCK_WAIVER = {
  reason: 'Author notified via Discord',
  actor: 'opus',
  evidence: 'https://discord.com/channels/123/456',
};

const FINDING_OPEN = {
  findingId: 'find-001',
  subjectKey: 'issue:test/repo#42',
  findingKind: 'sla-breach',
  severity: 'high',
  message: 'Response SLA exceeded: 72h without reply',
  status: 'open' as const,
  waiver: null,
  evidenceFingerprint: 'abc123',
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 86_400_000,
};

const FINDING_WARNING = {
  findingId: 'find-003',
  subjectKey: 'issue:test/repo#42',
  findingKind: 'reconciliation-mismatch',
  severity: 'warning',
  message: 'State mismatch detected',
  status: 'open' as const,
  waiver: null,
  evidenceFingerprint: 'ghi789',
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 86_400_000,
};

const FINDING_WAIVED = {
  findingId: 'find-002',
  subjectKey: 'issue:test/repo#42',
  findingKind: 'reconciliation-mismatch',
  severity: 'medium',
  message: 'GitHub state differs from local projection',
  status: 'waived' as const,
  waiver: { reason: 'Known sync delay', actor: 'codex', evidence: 'Sync scheduled for next cycle' },
  evidenceFingerprint: 'def456',
  createdAt: Date.now() - 172_800_000,
  updatedAt: Date.now() - 86_400_000,
};

// ---------------------------------------------------------------------------
// ClosureChecklistCard
// ---------------------------------------------------------------------------

describe('ClosureChecklistCard (D5)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows blocker detail with evidence source (INV-D6.3)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    // Must render blocker kind and detail text — not just a red badge
    const blockerEl = container.querySelector('[data-testid="blocker-fixed-not-reported"]');
    expect(blockerEl).toBeTruthy();
    expect(blockerEl!.textContent).toContain('Fix merged but not reported to author');
  });

  it('disables close button when blockers present and no waiver (INV-D6.1)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    const closeBtn = container.querySelector('[data-testid="close-issue-btn"]') as HTMLButtonElement | null;
    expect(closeBtn).toBeTruthy();
    expect(closeBtn!.disabled).toBe(true);
  });

  it('enables close button when readyToClose is true (INV-D6.1)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_READY,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    const closeBtn = container.querySelector('[data-testid="close-issue-btn"]') as HTMLButtonElement | null;
    expect(closeBtn).toBeTruthy();
    expect(closeBtn!.disabled).toBe(false);
  });

  it('enables close button when waiver is present even with blockers (INV-D6.1)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_WAIVED,
          waiver: MOCK_WAIVER,
          actor: 'opus',
        }),
      );
    });

    const closeBtn = container.querySelector('[data-testid="close-issue-btn"]') as HTMLButtonElement | null;
    expect(closeBtn).toBeTruthy();
    expect(closeBtn!.disabled).toBe(false);
  });

  it('shows waiver audit trail when waiver exists (INV-D6.3)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_WAIVED,
          waiver: MOCK_WAIVER,
          actor: 'opus',
        }),
      );
    });

    const waiverSection = container.querySelector('[data-testid="waiver-audit-trail"]');
    expect(waiverSection).toBeTruthy();
    expect(waiverSection!.textContent).toContain('Author notified via Discord');
    expect(waiverSection!.textContent).toContain('https://discord.com/channels/123/456');
  });

  it('"Mark as Reported" opens ReportAuditForm inline (like INV-D6.2 pattern)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    // Report form should NOT be visible initially
    expect(container.querySelector('[data-testid="report-audit-form"]')).toBeNull();

    const reportBtn = container.querySelector('[data-testid="mark-reported-btn"]') as HTMLButtonElement | null;
    expect(reportBtn).toBeTruthy();

    await React.act(async () => {
      reportBtn!.click();
    });

    // Report form should now be visible — requires publicCommentUrl
    expect(container.querySelector('[data-testid="report-audit-form"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="report-url-input"]')).toBeTruthy();
  });

  it('ReportAuditForm submits correct payload matching backend contract', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
          _forceShowReportForm: true,
        }),
      );
    });

    const urlInput = container.querySelector('[data-testid="report-url-input"]') as HTMLInputElement;
    await React.act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(urlInput, 'https://github.com/test/repo/issues/42#issuecomment-123');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = container.querySelector('[data-testid="report-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    await React.act(async () => {
      submitBtn.click();
    });

    const reportCall = fetchSpy.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && c[0].includes('/report'));
    expect(reportCall).toBeTruthy();
    expect(reportCall![0]).toContain('/api/community-issues/iss-42/report');
    expect((reportCall![1] as RequestInit)?.method).toBe('POST');

    const body = JSON.parse((reportCall![1] as RequestInit).body as string);
    expect(body.publicCommentUrl).toBe('https://github.com/test/repo/issues/42#issuecomment-123');
    expect(body.actor).toBe('opus');

    fetchSpy.mockRestore();
  });

  it('does NOT call onAction when report submit fails (res.ok=false)', async () => {
    const failFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad request' }),
    } as Response);

    const onAction = vi.fn();

    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
          onAction,
          _forceShowReportForm: true,
        }),
      );
    });

    const urlInput = container.querySelector('[data-testid="report-url-input"]') as HTMLInputElement;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(urlInput, 'https://github.com/test/repo/issues/42#issuecomment-123');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = container.querySelector('[data-testid="report-submit-btn"]') as HTMLButtonElement;
    await React.act(async () => {
      submitBtn.click();
    });

    // onAction should NOT be called — form should preserve input
    expect(onAction).not.toHaveBeenCalled();

    // Error message should be visible
    const errorEl = container.querySelector('[data-testid="report-error"]');
    expect(errorEl).toBeTruthy();

    // Form should still be visible
    expect(container.querySelector('[data-testid="report-audit-form"]')).toBeTruthy();

    failFetch.mockRestore();
  });

  it('close button calls onAction with "close" when enabled (INV-D6.1)', async () => {
    const onAction = vi.fn();

    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_READY,
          waiver: null,
          actor: 'opus',
          onAction,
        }),
      );
    });

    const closeBtn = container.querySelector('[data-testid="close-issue-btn"]') as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);

    await React.act(async () => {
      closeBtn.click();
    });

    expect(onAction).toHaveBeenCalledWith('close');
  });

  it('"Waive Closure" button opens WaiverAuditForm inline (INV-D6.2)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    // Form should NOT be visible initially
    expect(container.querySelector('[data-testid="waiver-audit-form"]')).toBeNull();

    const waiveBtn = container.querySelector('[data-testid="waive-closure-btn"]') as HTMLButtonElement | null;
    expect(waiveBtn).toBeTruthy();

    await React.act(async () => {
      waiveBtn!.click();
    });

    // Form should now be visible — no one-click waive
    expect(container.querySelector('[data-testid="waiver-audit-form"]')).toBeTruthy();
  });

  it('uses SVG icons, never emoji (INV-D6.4)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    // Grep for common emoji patterns — should find none
    const html = container.innerHTML;
    const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    expect(emojiPattern.test(html)).toBe(false);

    // Should have at least one SVG icon
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('hides "Waive Closure" button when blocker is not-in-closeable-state (cloud P2)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_NOT_CLOSEABLE,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    // Waiving doesn't apply when the issue isn't in a closeable state —
    // the backend would reject, so don't show the button
    const waiveBtn = container.querySelector('[data-testid="waive-closure-btn"]');
    expect(waiveBtn).toBeNull();
  });

  it('shows "Waive Closure" button for fixed-not-reported blocker (normal case)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
        }),
      );
    });

    const waiveBtn = container.querySelector('[data-testid="waive-closure-btn"]');
    expect(waiveBtn).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// WaiverAuditForm (inline in ClosureChecklistCard)
// ---------------------------------------------------------------------------

describe('WaiverAuditForm (D5 — INV-D6.2)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders required fields: reason and evidence', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
          _forceShowWaiverForm: true, // test-only prop to bypass click toggle
        }),
      );
    });

    const form = container.querySelector('[data-testid="waiver-audit-form"]');
    expect(form).toBeTruthy();

    const reasonInput = container.querySelector('[data-testid="waiver-reason-input"]');
    const evidenceInput = container.querySelector('[data-testid="waiver-evidence-input"]');
    expect(reasonInput).toBeTruthy();
    expect(evidenceInput).toBeTruthy();
  });

  it('submit button disabled when required fields are empty', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
          _forceShowWaiverForm: true,
        }),
      );
    });

    const submitBtn = container.querySelector('[data-testid="waiver-submit-btn"]') as HTMLButtonElement | null;
    expect(submitBtn).toBeTruthy();
    expect(submitBtn!.disabled).toBe(true);
  });

  it('does NOT call onSubmitted when server rejects waiver (res.ok=false)', async () => {
    const failFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'conflict' }),
    } as Response);

    const onAction = vi.fn();

    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
          onAction,
          _forceShowWaiverForm: true,
        }),
      );
    });

    // Fill form
    const reasonInput = container.querySelector('[data-testid="waiver-reason-input"]') as HTMLTextAreaElement;
    const evidenceInput = container.querySelector('[data-testid="waiver-evidence-input"]') as HTMLInputElement;

    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(reasonInput, 'test reason');
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(evidenceInput, 'test evidence');
      evidenceInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = container.querySelector('[data-testid="waiver-submit-btn"]') as HTMLButtonElement;
    await React.act(async () => {
      submitBtn.click();
    });

    // onAction should NOT be called — form should preserve input
    expect(onAction).not.toHaveBeenCalled();

    // Error message should be visible
    const errorEl = container.querySelector('[data-testid="waiver-error"]');
    expect(errorEl).toBeTruthy();

    // Form should still be visible (not dismissed)
    expect(container.querySelector('[data-testid="waiver-audit-form"]')).toBeTruthy();

    failFetch.mockRestore();
  });

  it('submits waiver with correct payload to POST endpoint (including actor)', async () => {
    await React.act(async () => {
      root.render(
        React.createElement(ClosureChecklistCard, {
          issueId: 'iss-42',
          checklist: CHECKLIST_BLOCKED,
          waiver: null,
          actor: 'opus',
          _forceShowWaiverForm: true,
        }),
      );
    });

    // Fill in the form fields
    const reasonInput = container.querySelector('[data-testid="waiver-reason-input"]') as HTMLTextAreaElement;
    const evidenceInput = container.querySelector('[data-testid="waiver-evidence-input"]') as HTMLInputElement;

    await React.act(async () => {
      // Simulate typing into reason field
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!
        .set!;
      nativeInputValueSetter.call(reasonInput, 'Author notified via Discord');
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await React.act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(evidenceInput, 'https://discord.com/channels/123/456');
      evidenceInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = container.querySelector('[data-testid="waiver-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    await React.act(async () => {
      submitBtn.click();
    });

    const waiveCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('/waive-closure'),
    );
    expect(waiveCall).toBeTruthy();
    expect(waiveCall![0]).toContain('/api/community-issues/iss-42/waive-closure');
    expect((waiveCall![1] as RequestInit)?.method).toBe('POST');

    const body = JSON.parse((waiveCall![1] as RequestInit).body as string);
    expect(body.reason).toBe('Author notified via Discord');
    expect(body.actor).toBe('opus');
    expect(body.evidence).toBe('https://discord.com/channels/123/456');
  });
});

// ---------------------------------------------------------------------------
// ReconciliationFindingCard
// ---------------------------------------------------------------------------

describe('ReconciliationFindingCard (D5)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders finding kind, severity, and message (INV-D6.3)', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_OPEN }));
    });

    const card = container.querySelector('[data-testid="finding-card-find-001"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('sla-breach');
    expect(card!.textContent).toContain('high');
    expect(card!.textContent).toContain('Response SLA exceeded');
  });

  it('shows evidence fingerprint as source indicator (INV-D6.3)', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_OPEN }));
    });

    const evidenceEl = container.querySelector('[data-testid="finding-evidence-find-001"]');
    expect(evidenceEl).toBeTruthy();
    expect(evidenceEl!.textContent).toContain('abc123');
  });

  it('shows action buttons for open findings when onAction provided', async () => {
    const onAction = vi.fn();
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_OPEN, onAction }));
    });

    expect(container.querySelector('[data-testid="finding-ack-btn-find-001"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="finding-resolve-btn-find-001"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="finding-waive-btn-find-001"]')).toBeTruthy();
  });

  it('hides action buttons for open findings when onAction is not provided', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_OPEN }));
    });

    expect(container.querySelector('[data-testid="finding-ack-btn-find-001"]')).toBeNull();
    expect(container.querySelector('[data-testid="finding-resolve-btn-find-001"]')).toBeNull();
    expect(container.querySelector('[data-testid="finding-waive-btn-find-001"]')).toBeNull();
  });

  it('shows waiver details with evidence for waived findings (INV-D6.3)', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_WAIVED }));
    });

    const waiverEl = container.querySelector('[data-testid="finding-waiver-find-002"]');
    expect(waiverEl).toBeTruthy();
    expect(waiverEl!.textContent).toContain('Known sync delay');
    expect(waiverEl!.textContent).toContain('Sync scheduled for next cycle');
    expect(waiverEl!.textContent).toContain('codex');
  });

  it('hides action buttons for waived findings', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_WAIVED }));
    });

    // Waived findings should not show acknowledge/resolve buttons
    expect(container.querySelector('[data-testid="finding-ack-btn-find-002"]')).toBeNull();
    expect(container.querySelector('[data-testid="finding-resolve-btn-find-002"]')).toBeNull();
  });

  it('maps warning severity to amber styling (backend emits warning)', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_WARNING }));
    });

    const card = container.querySelector('[data-testid="finding-card-find-003"]');
    expect(card).toBeTruthy();
    // warning should render with amber styling, not fall through to gray/low
    expect(card!.className).toContain('text-amber-400');
    expect(card!.className).not.toContain('text-cafe-muted');
  });

  it('uses SVG icons, never emoji (INV-D6.4)', async () => {
    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_OPEN }));
    });

    const html = container.innerHTML;
    const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    expect(emojiPattern.test(html)).toBe(false);
  });

  it('calls onAction callback when action buttons clicked', async () => {
    const onAction = vi.fn();

    await React.act(async () => {
      root.render(React.createElement(ReconciliationFindingCard, { finding: FINDING_OPEN, onAction }));
    });

    const ackBtn = container.querySelector('[data-testid="finding-ack-btn-find-001"]') as HTMLButtonElement;
    await React.act(async () => {
      ackBtn.click();
    });

    expect(onAction).toHaveBeenCalledWith('find-001', 'acknowledge');
  });
});
