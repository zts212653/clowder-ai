/** Contract fixture at the package→Host boundary; DOM producer checks live in the package. */
export function boundedFailureDiagnostic(path) {
  return {
    v: 1,
    errorCode: 'COMPOSER_DOM_UNSUPPORTED',
    nextAction: 'inspect_bound_tab',
    fingerprint: {
      v: 1,
      phase: 'inserted',
      adapterRevision: '2026-09-19.1',
      artifactRevision: '0.2.2',
      firstUnsupportedPath: path,
      truncated: true,
      nodes: [
        { path: 'composer', kind: 'element', tag: 'DIV', childCount: 1 },
        { path, kind: 'other', nodeType: 8 },
      ],
    },
  };
}
