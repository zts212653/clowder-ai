import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/context/PresentationLedger.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ContextSourceAdmission } from '../../dist/domains/memory/cue/ContextSourceAdmission.js';
import {
  CONTEXT_SOURCE_OPPORTUNITY_SCHEMA,
  ContextSourceOpportunityStore,
} from '../../dist/domains/memory/cue/ContextSourceOpportunityStore.js';
import { memoryCueOpportunityId } from '../../dist/domains/memory/cue/MemoryCueInvocationPromptService.js';

for (const carrier of ['exec_json', 'app_server'])
  test(`${carrier}: source correction in adapter preparation cannot reach provider; rebuild omits old pointer`, async (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(CONTEXT_SOURCE_OPPORTUNITY_SCHEMA);
    const admission = new ContextSourceAdmission({
      store: new ContextSourceOpportunityStore(db),
      messages: {
        getById: async () => ({
          id: 'source',
          userId: 'owner',
          threadId: 'thread',
          catId: null,
          content: 'ordinary task',
        }),
      },
      threads: { get: async () => ({ id: 'thread', createdBy: 'owner', projectPath: '/project' }) },
      tasks: { get: async () => null, listByThread: async () => [] },
    });
    const received = [];
    let current = true,
      attempts = 0;
    const source = 'OPAQUE_OLD_REVISION_HANDLE';
    const validSource = 'OPAQUE_VALID_PRIMER_HANDLE';
    const service = {
      contextCapability: () => ({
        provider: 'openai',
        carrier,
        reportsRuntimeWindow: true,
        authoritativeUsage: true,
        usageTelemetry: 'available',
        nativeWindowControl: true,
        nativeCompressionControl: true,
        observesCompression: true,
        reason: 'fixture',
      }),
      async *invoke(prompt, options) {
        attempts += 1;
        if (attempts === 1) current = false; // correction after presentation/reservation, before actual provider boundary
        try {
          await options.beforeProviderLaunch({
            v: 1,
            message: { body: prompt },
            nativeInstructions: [],
            runtime: { provider: 'openai', carrier: 'exec_json' },
            tools: { finalSurface: 'unknown' },
            providerNativeVisibility: 'unknown',
          });
        } catch {
          yield { type: 'error', catId: 'codex', error: 'adapter launch rejected', timestamp: Date.now() };
          return;
        }
        received.push(prompt);
        yield { type: 'text', catId: 'codex', content: 'continued safely', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    if (carrier === 'app_server')
      service.invokeWithContinuityPreflight = async function* (preflight, options) {
        const settled = await preflight.settle({
          evidence: { kind: 'started', runtimeSessionId: 'runtime' },
        });
        yield* service.invoke(settled.prompt, options);
      };
    const deps = {
      registry: {
        create: async () => ({ invocationId: 'invocation', callbackToken: 'token' }),
        verify: async () => ({ ok: false }),
      },
      sessionManager: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      contextSourceAdmission: admission,
      presentationLedger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
      memoryCuePromptService: {
        resolve: async (input) => {
          const seed = input.seeds.find((s) => s.kind === 'fresh_context_sources');
          if (!seed)
            return {
              promptSegment: '',
              admittedOpportunityIds: [],
              omittedOpportunityIds: [],
              deliveryReceipts: [],
              presentationEnvelopes: [],
            };
          const id = memoryCueOpportunityId(seed, input.serverScope, 'codex');
          const asOf = { kind: 'version', value: 'old' };
          return {
            promptSegment: source,
            admittedOpportunityIds: [id],
            omittedOpportunityIds: [],
            deliveryReceipts: [],
            presentationEnvelopes: [source, validSource].map((pointer) => {
              const subjectKey = `memory-cue:${pointer === source ? 'project_knowledge' : 'profile'}:${pointer}:consumer:codex`;
              return {
                validateCurrent: async () => pointer === validSource || current,
                candidate: { subjectKey, asOf, sourceTier: 'T2', requested: 'pointer', epistemicCeiling: 'pointer' },
                admission: {
                  opportunityId: id,
                  opportunityKind: 'recall',
                  producerOwner: 'context_epoch',
                  consumerScope: { kind: 'invocation', ...input.serverScope },
                  entryVersion: 'recall-catalog:7:fresh_context_sources:context_epoch',
                  subjectKey,
                  asOf,
                  sourceRefs: ['source'],
                  eligibleSurfaces: ['dynamic_context'],
                  presentationPolicyRef: 'F296.OpportunityPresentation',
                  tokenBudget: 900,
                  dedupeKey: 'source',
                  expiresAt: Date.now() + 300000,
                  invalidators: [{ owner: 'source', ref: 'revision' }],
                  epistemicCeiling: 'pointer',
                },
                segments: { pointer },
                receipt: { cueId: pointer, event: { opportunityId: id, scope: input.serverScope } },
              };
            }),
          };
        },
        recordPresented: async () => {},
      },
    };
    const output = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'ordinary task',
      userId: 'owner',
      threadId: 'thread',
      ownerAuthProvenance: 'strict',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      isLastCat: true,
      contextPromptFactory: async () => ({ prompt: 'ordinary task', promptMessageIds: [] }),
      executionCausal: { triggerMessageId: 'source' },
      contextSourceIngress: { kind: 'owner', sourceMessageId: 'source' },
    }))
      output.push(message);
    assert.equal(attempts, 2);
    assert.equal(received.length, 1);
    assert.ok(!received[0].includes(source));
    assert.ok(received[0].includes(validSource), 'the provider still receives the independent valid primer');
    assert.ok(output.some((message) => message.content === 'continued safely'));
    assert.ok(!output.some((message) => message.type === 'error'));
  });
