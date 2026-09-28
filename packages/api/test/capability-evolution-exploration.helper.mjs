export const id = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
export const objectRef = { ownerFeatureId: 'F100', ownerStateRef: 'capability:code-behavior' };
export const programRef = { ownerFeatureId: 'F311', ownerStateRef: id };
export const source = (name, version = 'v1') => ({ ownerFeatureId: 'F100', ownerStateRef: `source:${name}`, version });
export const experimentRef = source('run');
export const versionRef = { ...source('method'), assetKind: 'code', assetId: 'auth-handler' };
export const nodeRef = versionRef;
export const conditions = () => ({
  environment: { label: '隔离 Node 运行', detail: '真实调用，同一输入', sourceRef: source('environment') },
  sampleSet: { label: '固定输入集', detail: '一条输入', sourceRef: source('sample-set') },
  measurement: { label: '身份拒绝契约', detail: '无身份时应为 401', sourceRef: source('measurement') },
  groundTruth: { label: 'API 契约', detail: '仅证明这组输入', sourceRef: source('gt'), status: 'bounded' },
  window: { label: '本次调用', detail: '直到响应', sourceRef: source('window') },
  exposure: 'isolated_test',
  limitation: '隔离运行，不代表生产效用',
  threshold: { status: 'frozen', detail: '无身份必须拒绝', sourceRef: source('rule') },
  comparison: { design: 'paired', method: '相同输入的响应状态', planRef: source('plan') },
  preparationRefs: [],
});
export function explorationFixture({ withDetail = false, media } = {}) {
  const record = {
    recordRef: source('record'),
    experimentRef,
    nodeRef,
    caseId: 'anonymous',
    label: '未登录读取',
    inputRef: source('anonymous-input'),
    evidenceRef: source('actual-response'),
    windowRef: source('window'),
    measurementRef: source('measurement'),
    input: [{ label: '身份', value: '无' }],
    output: [{ label: 'HTTP', value: '401' }],
    result: { status: 'satisfied', label: '读取被拒绝' },
    values: { status: 401 },
    media: media ? [media] : [],
    sources: [{ label: '调用记录', ref: source('actual-response') }],
  };
  return {
    schemaVersion: 1,
    programRef,
    objectRef,
    status: 'resolved',
    sourceRef: source('publication'),
    readAt: '2026-09-09T14:00:00.000Z',
    nodes: [
      {
        kind: 'owner_version',
        nodeRef,
        versionRef,
        title: '身份守卫 v1',
        summary: '按请求身份拒绝读取',
        sourceRef: source('publication'),
        changes: [],
        parentEdges: [],
      },
    ],
    experiments: [
      {
        experimentRef,
        nodeRef,
        sourceRef: source('run'),
        title: '身份契约运行',
        status: 'recorded',
        recordCount: 1,
        conditions: conditions(),
        metrics: [
          {
            key: 'status',
            label: 'HTTP 状态',
            unit: 'code',
            definition: '实际响应状态码',
            sourceRef: source('measurement'),
          },
        ],
      },
    ],
    details: withDetail ? [{ status: 'resolved', experimentRef, nodeRef, records: [record] }] : [],
    blockers: [],
  };
}
