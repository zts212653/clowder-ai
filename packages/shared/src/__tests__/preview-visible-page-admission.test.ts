import { describe, expect, it } from 'vitest';
import {
  type PreviewVisiblePageAdmission,
  type PreviewVisiblePageAttestation,
  previewVisiblePageAdmissionSchema,
  verifyPreviewVisiblePageAttestation,
} from '../preview-visible-page-admission.js';

const REVISION = 'b'.repeat(40);
const TARGET_ORIGIN = 'http://preview-3011.localhost:4111';
const TARGET_PATH = '/thread/thread-f307?f307WorkbenchGate=true';
const WORKBENCH_SELECTOR = '[data-testid="f307-experience-workbench"]';

const admission: PreviewVisiblePageAdmission = {
  expectedClientRevision: REVISION,
  requiredDom: [
    {
      selector: WORKBENCH_SELECTOR,
      attributes: {
        'data-layout-owner': 'f307',
        'data-layout-hydrated': 'true',
        'data-surface-count': '0',
        'data-workbench-focus': 'home',
        'data-zero-topology-contract': 'canonical-home',
      },
      textIncludes: ['你想打开什么？'],
    },
  ],
  forbiddenText: ['工作台已清空', '关闭只移除了这里的承载面，对象仍由原位置保存。'],
};

function makeAttestation(overrides: Partial<PreviewVisiblePageAttestation> = {}): PreviewVisiblePageAttestation {
  return {
    eventId: 'evt-f307',
    targetPort: 3011,
    targetOrigin: TARGET_ORIGIN,
    targetPath: TARGET_PATH,
    clientRevision: REVISION,
    dom: [
      {
        selector: WORKBENCH_SELECTOR,
        found: true,
        attributes: {
          'data-layout-owner': 'f307',
          'data-layout-hydrated': 'true',
          'data-surface-count': '0',
          'data-workbench-focus': 'home',
          'data-zero-topology-contract': 'canonical-home',
        },
        textMatches: [true],
      },
    ],
    forbiddenTextMatches: [false, false],
    ...overrides,
  };
}

describe('Preview visible-page admission', () => {
  it('accepts only a same-event, same-port, same-origin, exact-revision DOM proof', () => {
    expect(
      verifyPreviewVisiblePageAttestation(admission, {
        eventId: 'evt-f307',
        targetPort: 3011,
        targetOrigin: TARGET_ORIGIN,
        targetPath: TARGET_PATH,
        attestation: makeAttestation(),
      }),
    ).toEqual({ verified: true, mismatches: [] });
  });

  it('fails the exact stale-client fingerprint instead of treating iframe load as proof', () => {
    const verdict = verifyPreviewVisiblePageAttestation(admission, {
      eventId: 'evt-f307',
      targetPort: 3011,
      targetOrigin: TARGET_ORIGIN,
      targetPath: TARGET_PATH,
      attestation: makeAttestation({
        clientRevision: 'a'.repeat(40),
        dom: [
          {
            selector: WORKBENCH_SELECTOR,
            found: true,
            attributes: {
              'data-layout-owner': 'f307',
              'data-layout-hydrated': 'true',
              'data-surface-count': '0',
              'data-workbench-focus': 'surface',
              'data-zero-topology-contract': null,
            },
            textMatches: [false],
          },
        ],
        forbiddenTextMatches: [true, true],
      }),
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.mismatches).toEqual(
      expect.arrayContaining([
        'client_revision_mismatch',
        'dom_attribute_mismatch:0:data-workbench-focus',
        'dom_attribute_mismatch:0:data-zero-topology-contract',
        'required_text_missing:0:0',
        'forbidden_text_present:0',
        'forbidden_text_present:1',
      ]),
    );
  });

  it('rejects the transient default DOM before persisted layout hydration completes', () => {
    const verdict = verifyPreviewVisiblePageAttestation(admission, {
      eventId: 'evt-f307',
      targetPort: 3011,
      targetOrigin: TARGET_ORIGIN,
      targetPath: TARGET_PATH,
      attestation: makeAttestation({
        dom: [
          {
            ...makeAttestation().dom[0],
            attributes: {
              ...makeAttestation().dom[0].attributes,
              'data-layout-hydrated': 'false',
            },
          },
        ],
      }),
    });

    expect(verdict).toEqual({
      verified: false,
      mismatches: ['dom_attribute_mismatch:0:data-layout-hydrated'],
    });
  });

  it('rejects proof from the previous path on the same port and origin', () => {
    const verdict = verifyPreviewVisiblePageAttestation(admission, {
      eventId: 'evt-f307',
      targetPort: 3011,
      targetOrigin: TARGET_ORIGIN,
      targetPath: '/thread/thread-new?f307WorkbenchGate=true',
      attestation: {
        ...makeAttestation(),
        targetPath: '/thread/thread-old?f307WorkbenchGate=true',
      },
    } as Parameters<typeof verifyPreviewVisiblePageAttestation>[1]);

    expect(verdict).toEqual({ verified: false, mismatches: ['target_path_mismatch'] });
  });

  it('keeps the fragment inside exact target identity', () => {
    const targetPath = '/thread/thread-f307?f307WorkbenchGate#surface-terminal';
    expect(
      verifyPreviewVisiblePageAttestation(admission, {
        eventId: 'evt-f307',
        targetPort: 3011,
        targetOrigin: TARGET_ORIGIN,
        targetPath,
        attestation: makeAttestation({ targetPath }),
      }),
    ).toEqual({ verified: true, mismatches: [] });

    expect(
      verifyPreviewVisiblePageAttestation(admission, {
        eventId: 'evt-f307',
        targetPort: 3011,
        targetOrigin: TARGET_ORIGIN,
        targetPath,
        attestation: makeAttestation({
          targetPath: '/thread/thread-f307?f307WorkbenchGate#surface-browser',
        }),
      }),
    ).toEqual({ verified: false, mismatches: ['target_path_mismatch'] });
  });

  it('bounds the admission contract and requires an exact build revision', () => {
    expect(previewVisiblePageAdmissionSchema.safeParse({ ...admission, expectedClientRevision: 'main' }).success).toBe(
      false,
    );
    expect(
      previewVisiblePageAdmissionSchema.safeParse({
        ...admission,
        requiredDom: Array.from({ length: 9 }, () => admission.requiredDom[0]),
      }).success,
    ).toBe(false);
  });
});
