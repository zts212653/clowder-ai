export type F269PreviewCaseId = 'settings-prose' | 'file-name' | 'tool-result';
export type F269PreviewView = 'design' | 'evidence';

export interface F269PreviewCase {
  id: F269PreviewCaseId;
  label: string;
  severity: 'U1' | 'U2';
  ledgerRecordId: string;
  screenshotFileName: string;
  proves: string;
  doesNotProve: string;
}

export const F269_PREVIEW_CASES: readonly F269PreviewCase[] = [
  {
    id: 'settings-prose',
    label: 'Phase A · meaningful prose with no recovery',
    severity: 'U1',
    ledgerRecordId: 'css:packages/web/src/components/settings/primitives/SettingsRow.tsx:82',
    screenshotFileName: 'overflow-css-packages-web-src-components-settings-primitives-settingsrow-tsx-82.png',
    proves:
      'The Phase A baseline received complete prose but showed only one clipped line, with no explicit way to read it.',
    doesNotProve: 'Whether a future shared prose primitive should expand inline or open a reader.',
  },
  {
    id: 'file-name',
    label: 'Phase A · compact identifier with no detail affordance',
    severity: 'U2',
    ledgerRecordId: 'css:packages/web/src/components/rich/FileBlock.tsx:71',
    screenshotFileName: 'overflow-css-packages-web-src-components-rich-fileblock-tsx-71.png',
    proves:
      'The full file name existed in the Phase A DOM value but the compact row had no tooltip, copy action, or detail view.',
    doesNotProve: 'Which Compact Label interaction should become the design-system default.',
  },
  {
    id: 'tool-result',
    label: 'Producer preview with no full reader',
    severity: 'U1',
    ledgerRecordId: 'producer:web:story-tool-result',
    screenshotFileName: 'overflow-producer-web-story-tool-result.png',
    proves:
      'Story Player physically cuts a long tool result and exposes only a loss marker, without a full-content reader.',
    doesNotProve: 'Whether the canonical replay payload still exists outside this renderer.',
  },
] as const;

const CASE_IDS = new Set<F269PreviewCaseId>(F269_PREVIEW_CASES.map((preview) => preview.id));

export function normalizeF269PreviewCase(value: string | string[] | undefined): F269PreviewCaseId {
  if (typeof value !== 'string' || !CASE_IDS.has(value as F269PreviewCaseId)) return 'settings-prose';
  return value as F269PreviewCaseId;
}

export function normalizeF269PreviewView(value: string | string[] | undefined): F269PreviewView {
  return value === 'evidence' ? 'evidence' : 'design';
}
