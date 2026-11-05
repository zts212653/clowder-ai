import { type RoutingContextReadModelV1, routingContextReadModelV1Schema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { model as base } from '../../routing-context/__tests__/team-panel-fixtures';
import { useRoutingContext } from '../../routing-context/useRoutingContext';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';
import { MemberCurrentStatus } from '../MemberCurrentStatus';

vi.mock('../../routing-context/useRoutingContext', () => ({ useRoutingContext: vi.fn() }));
vi.mock('../../settings/OpenTeamWorkspaceButton', () => ({
  OpenTeamWorkspaceButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
const now = new Date(2026, 9, 26, 10, 12).getTime();
const old = new Date(2026, 9, 11, 21, 9, 8).getTime();
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, data: RoutingContextReadModelV1;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  data = structuredClone(base);
  if (data.resolution.state !== 'fresh') throw Error('fresh fixture');
  data.observedAt = now;
  data.resolution.snapshot.observedAt = now;
  const candidate = data.resolution.snapshot.candidates[0];
  candidate.availability = 'available';
  candidate.effect = 'eligible';
  candidate.reasons = [{ code: 'routing_signal_recovered', summary: 'Recovered', sourceRefs: ['health'] }];
  data.signalEvents = [
    {
      v: 1,
      ownerId: 'owner-1',
      eventId: 'health',
      commandId: 'health',
      subjectRef: { type: 'cat', catId: 'codex-sol' },
      source: 'health_probe',
      eventType: 'recovered',
      state: 'available',
      reasonCode: 'routing_signal_recovered',
      observedAt: old,
      evidenceRef: 'health-check',
      closesSignalIds: ['retired-assertion'],
    },
  ];
  vi.mocked(useRoutingContext).mockImplementation(() => ({ data, loading: false, error: null, refresh: vi.fn() }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  writeShellLanguage('zh');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(language: 'zh' | 'en') {
  routingContextReadModelV1Schema.parse(data);
  await act(async () => {
    writeShellLanguage(language);
    root.render(
      <MemberCopyProvider>
        <MemberCurrentStatus cat={{ id: 'codex-sol' } as CatData} />
      </MemberCopyProvider>,
    );
  });
}
it.each(['zh', 'en'] as const)('does not present an old health recovery as the latest work in %s', async (language) => {
  await render(language);
  expect(host.textContent).toContain(language === 'zh' ? '还没有接活记录' : 'No work records yet');
  expect(host.textContent).not.toMatch(/已恢复|Recovered/);
  expect(host.querySelector('time')).toBeNull();
});
it('does not claim an empty work history when the owner store cannot be read', async () => {
  data.signalEvents = [];
  data.resolution = {
    state: 'degraded',
    reason: 'routing_store_unavailable',
    affectedCatIds: ['codex-sol'],
    candidateBindings: [],
  };
  await render('zh');
  expect(host.textContent).toContain('未确认');
  expect(host.textContent).not.toContain('还没有接活记录');
});
it.each(['zh', 'en'] as const)('shows the latest dispatch result and its own short time in %s', async (language) => {
  data.signalEvents.push({
    ...data.signalEvents[0],
    eventId: 'success',
    commandId: 'success',
    source: 'dispatch_success',
    reasonCode: 'dispatch_success_probe',
    observedAt: new Date(2026, 9, 26, 9, 12).getTime(),
    evidenceRef: 'invocation:success',
  });
  // A newer health event must not replace the actual work result or timestamp.
  data.signalEvents[0].observedAt = now;
  await render(language);
  expect(host.textContent).toContain(
    language === 'zh' ? '最近一次接活顺利完成' : 'The latest work dispatch finished successfully',
  );
  expect(host.querySelector('time')?.textContent?.trim()).toBe('· 09:12');
  data.signalEvents.push({
    v: 1,
    ownerId: 'owner-1',
    eventId: 'failed',
    commandId: 'failed',
    subjectRef: { type: 'cat', catId: 'codex-sol' },
    source: 'provider_error',
    eventType: 'asserted',
    state: 'unavailable',
    reasonCode: 'provider_timeout',
    observedAt: new Date(2026, 9, 26, 9, 45).getTime(),
    validUntil: now + 60000,
    evidenceRef: 'invocation:failure',
  });
  await render(language);
  expect(host.textContent).toContain(language === 'zh' ? '服务响应超时' : 'Service timed out');
  expect(host.querySelector('time')?.textContent?.trim()).toBe('· 09:45');
});
it('uses month-day for earlier work and ignores another member’s newer result', async () => {
  data.signalEvents.push({
    ...data.signalEvents[0],
    eventId: 'success',
    commandId: 'success',
    source: 'dispatch_success',
    reasonCode: 'dispatch_success_probe',
    observedAt: old,
    evidenceRef: 'invocation:success',
  });
  data.signalEvents.push({
    ...data.signalEvents[0],
    eventId: 'other',
    subjectRef: { type: 'cat', catId: 'other' },
    source: 'dispatch_success',
    observedAt: now,
  });
  await render('zh');
  expect(host.querySelector('time')?.textContent?.trim()).toBe('· 10-11');
  expect(host.textContent).not.toContain('2026');
});

it.each([
  ['quota_exhausted', '额度已用完', 'Quota used up'],
  ['authentication_rejected', '登录验证未通过', 'Sign-in was rejected'],
  ['provider_unreachable', '没连上服务', 'Could not reach the service'],
] as const)('explains the producer’s %s failure without dumping diagnostic notes', async (reasonCode, zh, en) => {
  data.signalEvents.push({
    v: 1,
    ownerId: 'owner-1',
    eventId: 'failed',
    commandId: 'failed',
    subjectRef: { type: 'cat', catId: 'codex-sol' },
    source: 'provider_error',
    eventType: 'asserted',
    state: 'unavailable',
    reasonCode,
    observedAt: now - 60000,
    validUntil: now + 60000,
    evidenceRef: 'invocation:failure',
    note: 'verbose diagnostic\nnot header content',
  });
  await render('zh');
  expect(host.textContent).toContain(zh);
  await render('en');
  expect(host.textContent).toContain(en);
  expect(host.textContent).not.toContain('verbose diagnostic');
});
