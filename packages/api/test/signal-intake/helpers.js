import { createHash } from 'node:crypto';
import {
  HostInventoryControlPlane,
  MemoryMeetingIntakeStore,
  MemoryPluginInventoryStore,
  MemorySignalRouteStore,
  MemorySignalRuntimeLeaseStore,
  SignalAdmissionService,
} from '../../dist/domains/signal-intake/index.js';

export const SIGNAL_TYPE = 'example.meeting.generated.v1';
export const SCHEMA_REF = 'schemas/example-meeting.schema.json';

const schema = {
  type: 'object',
  properties: {
    payload: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', pattern: '^[a-z0-9-]+$' },
        title: { type: 'string', maxLength: 100 },
      },
      required: ['artifactId'],
      additionalProperties: false,
    },
    source: {
      type: 'object',
      properties: { handle: { type: 'string', pattern: '^example://meeting/[a-z0-9-]+$' } },
      required: ['handle'],
      additionalProperties: false,
    },
  },
  required: ['payload', 'source'],
  additionalProperties: false,
};

export function manifest() {
  return {
    pluginId: 'official.example-meeting',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Example Meeting',
    features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['events.publish'] }],
    signals: {
      provides: [
        {
          type: SIGNAL_TYPE,
          schemaRef: SCHEMA_REF,
          epistemicStatus: 'observation',
          privacyClass: 'content-adjacent',
          sourceClass: 'remote-service',
        },
      ],
    },
    runtime: { transport: 'builtin' },
  };
}

export function publishInput(overrides = {}) {
  return {
    signalType: SIGNAL_TYPE,
    eventId: 'evt-1',
    idempotencyKey: 'meeting:artifact-1:v1',
    occurredAt: '2026-08-09T12:00:00Z',
    payload: { artifactId: 'artifact-1', title: 'Weekly sync' },
    source: { handle: 'example://meeting/artifact-1' },
    ...overrides,
  };
}

export async function admissionHarness(options = {}) {
  const inventory = new MemoryPluginInventoryStore();
  const controlPlane = new HostInventoryControlPlane(inventory, {
    createInstanceId: () => 'pi_example',
    now: () => 1_000,
  });
  const digest = `sha512-${createHash('sha512').update('example-package').digest('base64')}`;
  await controlPlane.installPackage({
    manifest: manifest(),
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: 'official.example-meeting',
    effectiveGrants: ['events.publish'],
    signalSchemas: { [SCHEMA_REF]: schema },
  });
  await inventory.transaction((tx) => {
    const current = tx.instances.get('pi_example');
    tx.instances.put({
      ...current,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
    });
  });

  const runtimeLeases = new MemorySignalRuntimeLeaseStore();
  runtimeLeases.put({
    leaseId: 'lease-1',
    sessionId: 'session-1',
    pluginInstanceId: 'pi_example',
    packageDigest: digest,
    grantRevision: 1,
    state: 'live',
    expiresAt: 20_000,
  });
  const routes = new MemorySignalRouteStore();
  await routes.put({
    routeId: 'route-meetings',
    ownerId: 'owner-1',
    pluginId: 'official.example-meeting',
    signalType: SIGNAL_TYPE,
    generation: 3,
    state: 'active',
    workflowKind: 'meeting-intake',
    initialUnresolved: ['speakers', 'context', 'destination', 'outputs'],
    updatedAt: 1_000,
  });
  const intakes = options.intakes ?? new MemoryMeetingIntakeStore();
  let nextPublication = 1;
  const service = new SignalAdmissionService({
    inventory,
    runtimeLeases,
    routes,
    intakes,
    now: () => options.now ?? 10_000,
    createPublicationId: () => `pub-${nextPublication++}`,
    createIntakeId: () => 'intake-1',
    ...(options.traces ? { traces: options.traces } : {}),
  });
  const binding = {
    pluginInstanceId: 'pi_example',
    packageDigest: digest,
    sessionId: 'session-1',
    runtimeLeaseId: 'lease-1',
    grantRevision: 1,
    routeGeneration: 3,
  };
  return { binding, controlPlane, intakes, inventory, routes, runtimeLeases, service };
}
