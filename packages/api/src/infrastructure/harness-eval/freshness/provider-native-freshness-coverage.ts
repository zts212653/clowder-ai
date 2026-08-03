import type {
  FreshnessAttentionEvent,
  ProviderNativeFreshnessCarrier,
  ProviderNativeFreshnessDeliverySemantics,
  ProviderNativeFreshnessProvider,
  ProviderNativeFreshnessToolSurface,
} from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';

const REQUIRED_ALL_TOOL_SURFACES = [
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'dynamic_tool_call',
] as const satisfies readonly ProviderNativeFreshnessToolSurface[];

export interface ProviderNativeFreshnessCoverageCell {
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  toolSurface: ProviderNativeFreshnessToolSurface;
  opportunityCount: number;
  deliveredCount: number;
  missedCount: number;
  seenCount: number;
  handledCount: number;
}

export interface ProviderNativeFreshnessCarrierCoverage {
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  allToolCoverage: boolean;
  missingSurfaces: ProviderNativeFreshnessToolSurface[];
}

export interface ProviderNativeFreshnessCoverageReport {
  cells: ProviderNativeFreshnessCoverageCell[];
  carriers: ProviderNativeFreshnessCarrierCoverage[];
  verdict: 'no_data' | 'partial' | 'all_tool_covered';
}

type ProviderNativeNoticeEvent = Extract<
  FreshnessAttentionEvent,
  {
    kind:
      | 'provider_notice_opportunity'
      | 'provider_notice_prepared'
      | 'provider_notice_delivered'
      | 'provider_notice_missed'
      | 'provider_notice_seen'
      | 'provider_notice_handled';
  }
>;

function isProviderNotice(event: FreshnessAttentionEvent): event is ProviderNativeNoticeEvent {
  return event.kind.startsWith('provider_notice_') && 'provider' in event && 'toolSurface' in event;
}

export function buildProviderNativeFreshnessCoverage(
  events: readonly FreshnessAttentionEvent[],
): ProviderNativeFreshnessCoverageReport {
  const cells = new Map<string, ProviderNativeFreshnessCoverageCell>();
  for (const event of events) {
    if (!isProviderNotice(event)) continue;
    const key = [event.provider, event.carrier, event.deliverySemantics, event.toolSurface].join('\0');
    const cell = cells.get(key) ?? {
      provider: event.provider,
      carrier: event.carrier,
      deliverySemantics: event.deliverySemantics,
      toolSurface: event.toolSurface,
      opportunityCount: 0,
      deliveredCount: 0,
      missedCount: 0,
      seenCount: 0,
      handledCount: 0,
    };
    if (event.kind === 'provider_notice_opportunity') cell.opportunityCount++;
    else if (event.kind === 'provider_notice_delivered') cell.deliveredCount++;
    else if (event.kind === 'provider_notice_missed') cell.missedCount++;
    else if (event.kind === 'provider_notice_seen') cell.seenCount++;
    else if (event.kind === 'provider_notice_handled') cell.handledCount++;
    cells.set(key, cell);
  }

  const sortedCells = [...cells.values()].sort((left, right) =>
    [left.provider, left.carrier, left.deliverySemantics, left.toolSurface]
      .join(':')
      .localeCompare([right.provider, right.carrier, right.deliverySemantics, right.toolSurface].join(':')),
  );
  const carriers = new Map<string, ProviderNativeFreshnessCarrierCoverage>();
  for (const cell of sortedCells) {
    const key = [cell.provider, cell.carrier, cell.deliverySemantics].join('\0');
    if (carriers.has(key)) continue;
    const siblings = sortedCells.filter(
      (candidate) =>
        candidate.provider === cell.provider &&
        candidate.carrier === cell.carrier &&
        candidate.deliverySemantics === cell.deliverySemantics,
    );
    const missingSurfaces = REQUIRED_ALL_TOOL_SURFACES.filter(
      (surface) => !siblings.some((candidate) => candidate.toolSurface === surface && candidate.seenCount > 0),
    );
    carriers.set(key, {
      provider: cell.provider,
      carrier: cell.carrier,
      deliverySemantics: cell.deliverySemantics,
      allToolCoverage: cell.deliverySemantics !== 'unsupported' && missingSurfaces.length === 0,
      missingSurfaces: [...missingSurfaces],
    });
  }
  const carrierRows = [...carriers.values()];
  return {
    cells: sortedCells,
    carriers: carrierRows,
    verdict:
      sortedCells.length === 0
        ? 'no_data'
        : carrierRows.some((carrier) => carrier.allToolCoverage)
          ? 'all_tool_covered'
          : 'partial',
  };
}
