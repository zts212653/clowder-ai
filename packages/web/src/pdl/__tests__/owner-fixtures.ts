export function memoryInput() {
  return {
    view: 'all',
    cat: 'taste',
    q: '',
    sort: 'recent',
    win: 7,
    src: 'all',
    who: '',
    lib: 'pending',
    docLimits: {},
    node: '',
    graphQ: '',
    rel: {},
    targets: {},
    searched: '',
    type: 'all',
    depth: 'summary',
    limit: 10,
    brakeRange: '30',
    brakeWord: 'all',
    brakeSel: '',
    recallSources: [],
    recallAnchor: '',
    curation: null,
    limits: { taste: 20, profile: 20, person: 20, entity: 20, event: 20 },
  };
}
export function ownerInput() {
  return {
    voice: { sourceId: '', allowHomeReads: false, termEdit: null },
    m: memoryInput(),
    memoryEdit: { current: null },
    memoryLibraryDraft: { current: { kind: 'project', name: '', displayName: '', root: '', sensitivity: 'internal' } },
    evolutionReading: { current: {} },
    evalDuty: { current: {} },
  };
}
export function ownerData() {
  const read = () => ({ data: null, loading: false, error: false });
  const reads = (names: string[]) => Object.fromEntries(names.map((n) => [n, read()]));
  const explore = {
    documents: {},
    reads: reads([
      'catalog',
      'feed',
      'index',
      'maintenance',
      'healthReport',
      'toolUsage',
      'curation',
      'flags',
      'ledger',
      'axes',
      'services',
      'serviceLogs',
    ]),
    recall: { page: null, events: [], loading: false, error: false, moreLoading: false, moreError: false },
    brakes: { events: [], loading: false, error: false, hasMore: false },
    brakeSource: { id: '', load: '', canOpen: false },
    search: { key: '', load: '', data: null },
    libraryScan: null,
    libraryCreated: null,
    libraryBusy: '',
    libraryError: '',
    graph: null,
    graphLoading: false,
    graphError: null,
    receipt: null,
    rebuild: null,
    rebuildError: null,
  };
  return {
    settings: settingsInput(),
    team: { value: null, loading: true, error: null },
    signals: {
      read: { load: 'loading', articles: [], sources: [], stats: null, timeline: [] },
      detail: { id: '', load: 'loading' },
      fetching: null,
      discussion: null,
      playing: { index: -1, state: 'idle' },
    },
    evolution: {
      query: { programs: [], loading: true, error: null, rejected: null },
      exact: { projection: null, loading: false, error: null },
      requests: { records: {}, errors: {} },
      explorationRequests: { records: {}, errors: {} },
      assets: { loading: false, error: null },
      exploration: null,
    },
    ops: { read: { key: '', load: 'loading' }, governance: null, rescueRun: null, profiles: [], writing: false },
    evaluation: { load: 'loading' },
    voice: {
      session: null,
      settings: { customTerms: [], language: 'auto', customPrompt: '' },
      services: { load: 'loading', items: [] },
      serviceLogs: { data: null, loading: false, error: null },
      vadState: 'idle',
      capture: {
        status: { running: false },
        sources: { mics: [], apps: [] },
        lines: [],
        share: { kind: 'unavailable' },
        load: 'loading',
      },
      saved: null,
      call: null,
      transcript: { messages: [] },
      share: null,
      error: '',
      worktrees: [],
    },
    desktop: {
      available: false,
      currentVersion: null,
      load: 'loading',
      settings: null,
      prompt: null,
      progress: null,
      error: null,
    },
    sources: { records: { evidence: {}, works: {}, generations: {} }, error: null },
    general: { snapshot: { effective: 'next_work' }, error: null, viewError: null },
    memory: {
      reads: reads(['person', 'profile', 'event', 'entity', 'taste']),
      detail: null,
      document: null,
      load: '',
      error: '',
      explore,
    },
    trash: { threads: [], error: null },
  };
}

export function systemSummaryFixture() {
  const rows: [string, string | null, string, string][] = [
    ['API_SERVER_PORT', '4014', '4004', 'network'],
    ['PREVIEW_GATEWAY_PORT', '4111', '4100', 'network'],
    ['API_SERVER_HOST', '127.0.0.1', '127.0.0.1', 'network'],
    ['FRONTEND_URL', 'https://console.test', '(auto)', 'network'],
    ['FRONTEND_PORT', '4013', '4003', 'network'],
    ['CORS_ALLOW_PRIVATE_NETWORK', 'false', 'false', 'network'],
    ['PREVIEW_GATEWAY_ENABLED', null, '1 (enabled)', 'network'],
    ['CAT_CAFE_DATA_DIR', '/fixture/data', '/default/data', 'storage'],
    ['REDIS_URL', 'redis://localhost:6412', 'redis://localhost:6379', 'storage'],
    ['REDIS_KEY_PREFIX', 'fixture:', 'default:', 'storage'],
    ['UPLOAD_DIR', '/fixture/uploads', './uploads', 'storage'],
    ['TRANSCRIPT_DATA_DIR', '/fixture/transcripts', '<root>/transcripts', 'storage'],
    ['MEMORY_STORE', '0', '(unset)', 'storage'],
    ['MESSAGE_TTL_SECONDS', '604800', '604800 (7 days)', 'lifecycle'],
    ['THREAD_TTL_SECONDS', '0', '604800 (7 days)', 'lifecycle'],
    ['TASK_TTL_SECONDS', '604800', '604800 (7 days)', 'lifecycle'],
    ['SUMMARY_TTL_SECONDS', '0', '604800 (7 days)', 'lifecycle'],
    ['BACKLOG_TTL_SECONDS', '0', '604800 (7 days)', 'lifecycle'],
    ['CLI_TIMEOUT_MS', '60000', '1800000', 'runtime'],
    ['LOG_LEVEL', 'info', 'info', 'runtime'],
    ['PROJECT_ALLOWED_ROOTS', '/fixture', '(unset)', 'security'],
    ['PROJECT_ALLOWED_ROOTS_APPEND', null, '(unset)', 'security'],
    ['PROJECT_DENIED_ROOTS', '/fixture/private', '(unset)', 'security'],
    ['DEFAULT_OWNER_USER_ID', 'fixture-owner', '(unset)', 'security'],
  ];
  const semantics: Record<string, { defaultOn: boolean; trueWhen: 'exactTrue' | 'exactOne' | 'notZero' }> = {
    CORS_ALLOW_PRIVATE_NETWORK: { defaultOn: false, trueWhen: 'exactTrue' },
    PREVIEW_GATEWAY_ENABLED: { defaultOn: true, trueWhen: 'notZero' },
    MEMORY_STORE: { defaultOn: false, trueWhen: 'exactOne' },
  };
  return {
    groups: {
      network: 'Network',
      storage: 'Storage',
      lifecycle: 'Lifecycle',
      runtime: 'Runtime',
      security: 'Security',
    },
    variables: rows.map(([name, currentValue, defaultValue, settingsGroup]) => ({
      name,
      currentValue,
      defaultValue,
      settingsGroup,
      category: settingsGroup,
      description: name,
      sensitive: false,
      runtimeEditable: name === 'PREVIEW_GATEWAY_PORT',
      restartRequired: true,
      ...(semantics[name] ? { booleanSemantics: semantics[name] } : {}),
    })),
  };
}

export function environmentSummaryFixture() {
  const { groups, variables } = systemSummaryFixture();
  return {
    categories: groups,
    variables,
    paths: {
      projectRoot: '/fixture/project',
      homeDir: '/fixture/home',
      dataDirs: {
        auditLogs: '/fixture/audit',
        runtimeLogs: '/fixture/runtime-logs',
        cliArchive: '/fixture/cli-archive',
        redisDevSandbox: '/fixture/redis',
        uploads: '/fixture/uploads',
      },
    },
  };
}

export function settingsInput() {
  return {
    env: null,
    system: null,
    envPending: [],
    follows: {},
    plugins: null,
    pluginFragments: {},
    pluginDetails: {},
    pluginDocumentation: {},
    pluginTools: {},
    pluginLibraries: {},
    pluginPermissions: {},
    pluginPermissionsErrors: {},
    audit: null,
    auditError: '',
    marketSources: null,
    marketError: '',
    hooks: null,
    hooksError: '',
    connections: {},
    pageAction: null,
    pageActionPages: [],
    pageActionError: '',
  };
}
