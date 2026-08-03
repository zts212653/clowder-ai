import { basename } from 'node:path';

function deriveSurface(path) {
  const withoutPrefix = path.replace(/^packages\/web\/src\//, '').replace(/^packages\/api\/src\//, 'api/');
  return withoutPrefix.replace(/\.(?:tsx?|jsx?)$/, '');
}

function deriveComponent(path) {
  return basename(path).replace(/\.(?:tsx?|jsx?)$/, '');
}

function deriveField(record) {
  if (record.fieldHint) return record.fieldHint;
  const expressions = [...record.sourceExcerpt.matchAll(/\{([^{}]{1,160})\}/g)]
    .map((match) => match[1].trim())
    .filter((value) => value && !value.startsWith('`'));
  return expressions.at(-1) ?? record.sourceToken;
}

function lexicalNoiseExclusion(source) {
  return {
    id: source.id,
    disposition: 'excluded',
    exclusionReason: 'Lexical test, comment, type, or helper usage with no text overflow token.',
    surface: 'not applicable',
    component: deriveComponent(source.path),
    field: source.sourceToken,
    contentKind: 'non-content',
    truncationStage: 'not-applicable',
    fullContentAvailability: 'not-applicable',
    currentRecovery: [],
    inputCoverage: { mouse: false, keyboard: false, touch: false, screenReader: false },
    targetPattern: 'exclude',
    owner: 'hub-action-surface',
    rationale: 'The raw lexical baseline retains this source line, but it does not render truncated user content.',
  };
}

function applyBaselineAssignments(config, assignments) {
  if (config.baselineIds === undefined && config.baselineProfile === undefined) return;
  if (!Array.isArray(config.baselineIds) || typeof config.baselineProfile !== 'string') {
    throw new Error('classification baseline requires baselineProfile and baselineIds');
  }
  for (const id of config.baselineIds) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('classification baseline id is required');
    if (assignments[id] !== undefined) throw new Error(`duplicate baseline assignment: ${id}`);
    assignments[id] = config.baselineProfile;
  }
}

function applyExplicitAssignments(config, assignments) {
  const explicitIds = new Set();
  for (const [id, assignment] of Object.entries(config.assignments ?? {})) {
    assignments[id] = assignment;
    explicitIds.add(id);
  }
  return explicitIds;
}

function validateAssignmentGroup(group) {
  if (!group || typeof group.profile !== 'string' || !Array.isArray(group.ids)) {
    throw new Error('classification assignment group requires profile and ids');
  }
}

function addGroupedAssignment(id, profile, assignments, explicitIds) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('classification assignment id is required');
  if (explicitIds.has(id)) throw new Error(`duplicate assignment: ${id}`);
  assignments[id] = profile;
  explicitIds.add(id);
}

function applyAssignmentGroups(config, assignments, explicitIds) {
  const groups = config.assignmentGroups ?? [];
  if (!Array.isArray(groups)) throw new Error('classification config assignmentGroups must be an array');
  for (const group of groups) {
    validateAssignmentGroup(group);
    for (const id of group.ids) addGroupedAssignment(id, group.profile, assignments, explicitIds);
  }
}

function buildAssignments(config) {
  const assignments = {};
  applyBaselineAssignments(config, assignments);
  const explicitIds = applyExplicitAssignments(config, assignments);
  applyAssignmentGroups(config, assignments, explicitIds);
  return assignments;
}

function assertAssignmentCoverage(sources, assignments) {
  const actionable = sources.filter((source) => source.candidateKind !== 'lexical-noise');
  const actionableIds = new Set(actionable.map((source) => source.id));
  const stale = Object.keys(assignments).filter((id) => !actionableIds.has(id));
  if (stale.length > 0) throw new Error(`stale assignment: ${stale.join(', ')}`);

  const missing = actionable.filter((source) => assignments[source.id] === undefined).map((source) => source.id);
  if (missing.length > 0) throw new Error(`missing assignment: ${missing.join(', ')}`);
}

function materializeAssignedSource(source, assignments, profiles) {
  if (source.candidateKind === 'lexical-noise') return lexicalNoiseExclusion(source);
  const assignment = assignments[source.id];
  const profileId = typeof assignment === 'string' ? assignment : assignment.profile;
  const overrides = typeof assignment === 'string' ? {} : { ...assignment };
  delete overrides.profile;
  const profile = profiles[profileId];
  if (!profile || typeof profile !== 'object') {
    throw new Error(`assignment ${source.id} references unknown profile: ${profileId}`);
  }
  return {
    ...profile,
    id: source.id,
    surface: deriveSurface(source.path),
    component: deriveComponent(source.path),
    field: deriveField(source),
    ...overrides,
  };
}

export function materializeClassifications({ cssScan, producerRecords, config }) {
  if (!config || typeof config.profiles !== 'object') {
    throw new Error('classification config requires profiles');
  }
  const sources = [...cssScan.records, ...producerRecords];
  const assignments = buildAssignments(config);
  assertAssignmentCoverage(sources, assignments);

  return sources.map((source) => materializeAssignedSource(source, assignments, config.profiles));
}
