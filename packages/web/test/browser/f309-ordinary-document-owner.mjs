import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { registerNativeMediaOwnerRoutes } from './f309-artwork-lightbox-native-owner.mjs';
import { createDocumentProviderDriver } from './f309-document-provider-driver.mjs';
import { startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';

/** Real F063/Task/journal/receipt/callback routes. Only human session issuance and the provider are synthetic. */
export async function startRealDocumentOwner(dataDir, { executionSource = 'carrier', media = false } = {}) {
  return startRealWorkspaceOwner(dataDir, {
    configure: async ({ app, content, root }) => {
      const { catRegistry, createCatId } = await import('../../../shared/dist/index.js');
      const { loadCatConfig, toAllCatConfigs } = await import('../../../api/dist/config/cat-config-loader.js');
      for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(path.join(root, 'cat-template.json')))))
        if (!catRegistry.has(id)) catRegistry.register(id, config);
      const catId = 'codex61-sol';
      // The isolated template lacks this runtime identity. Register the deterministic provider explicitly,
      // as the API fixture does; never load a personal catalog or silently choose a different cat.
      if (!catRegistry.has(catId))
        catRegistry.register(catId, {
          ...catRegistry.getOrThrow('codex').config,
          id: createCatId(catId),
          displayName: '小太阳·砚砚',
          variantLabel: '隔离文档旅程',
          defaultModel: 'gpt-6.1-sol',
        });
      assert.ok(catRegistry.has(catId), 'the explicit isolated provider target exists');
      const { MessageStore } = await import('../../../api/dist/domains/cats/services/stores/ports/MessageStore.js');
      const { ThreadStore } = await import('../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js');
      const { TaskStore } = await import('../../../api/dist/domains/cats/services/stores/ports/TaskStore.js');
      const { DeliveryCursorStore } = await import(
        '../../../api/dist/domains/cats/services/stores/ports/DeliveryCursorStore.js'
      );
      const { InvocationRegistry } = await import(
        '../../../api/dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
      );
      const { createArtifactReviewIntegration } = await import(
        '../../../api/dist/domains/growing/artifact-review-composition.js'
      );
      const { ProjectContentOwnerService } = await import(
        '../../../api/dist/domains/video-studio/content-owner/service.js'
      );
      const { F232PreparedArtifactReader } = await import(
        '../../../api/dist/domains/growing/F232PreparedArtifactReader.js'
      );
      const { createContentModificationIntegration } = await import(
        '../../../api/dist/domains/collaborative-content/modification/composition.js'
      );
      const { registerContentModificationRoutes } = await import(
        '../../../api/dist/routes/content-modification-routes.js'
      );
      const { registerCallbackContentModificationRoutes } = await import(
        '../../../api/dist/routes/callback-content-modification-routes.js'
      );
      const { callbacksRoutes } = await import('../../../api/dist/routes/callbacks.js');
      const { workspaceEditRoutes } = await import('../../../api/dist/routes/workspace-edit.js');
      const { messagesRoutes } = await import('../../../api/dist/routes/messages.js');
      await app.register(workspaceEditRoutes);
      const messages = new MessageStore(),
        threads = new ThreadStore(),
        tasks = new TaskStore();
      const thread = threads.create('operator', '一起修改文档', root);
      const driver = createDocumentProviderDriver(messages, { executionSource });
      const errors = [],
        events = [];
      const socket = {
        emitToUser: (...args) => events.push(args),
        broadcastAgentMessage: (...args) => events.push(args),
        broadcastToRoom: (...args) => events.push(args),
      };
      const artifacts = createArtifactReviewIntegration({
        dataDir,
        uploadDir: dataDir,
        owner: new ProjectContentOwnerService({ dataDir }),
        publications: new F232PreparedArtifactReader({ messages }),
        workspace: content.source,
        tasks,
        threads,
        messages,
        delivery: driver.delivery,
        emit: socket.emitToUser,
        onError: (error) => errors.push(error),
      });
      const integration = createContentModificationIntegration({
        dataDir,
        source: content.source,
        files: content.reviews,
        artifacts,
        tasks,
        messages,
        turnExecutions: driver.turns,
        queue: driver.queue,
        delivery: driver.delivery,
        changed: () => events.push(['changed']),
        onError: (error) => errors.push(error),
      });
      const registry = new InvocationRegistry();
      const auth = await registry.create('operator', catId, thread.id);
      const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
      if (media)
        await registerNativeMediaOwnerRoutes({
          app,
          artifacts,
          integration,
          threads,
          messages,
          tasks,
          registry,
          dataDir,
          socketManager: socket,
        });
      // Use the production history projection, including its Host speaker and visibility rules.
      // Human send/provider dispatch is a separate declared boundary; never pretend an unused router ran.
      await app.register(async (scope) => {
        scope.addHook('onRequest', async (request, reply) => {
          if (request.method !== 'GET') return reply.code(501).send({ error: 'fixture_history_is_read_only' });
        });
        await scope.register(messagesRoutes, {
          registry,
          messageStore: messages,
          threadStore: threads,
          socketManager: socket,
          router: {},
          turnExecutionStore: driver.turns,
        });
      });
      registerContentModificationRoutes(app, integration);
      await registerCallbackContentModificationRoutes(app, {
        ...integration,
        threads,
        registry,
        changed: () => events.push(['changed']),
      });
      await app.register(callbacksRoutes, {
        registry,
        messageStore: messages,
        threadStore: threads,
        taskStore: tasks,
        socketManager: socket,
        deliveryCursorStore: new DeliveryCursorStore(),
      });
      const human = { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } };
      async function callback(operation, payload, authHeaders = headers) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/callbacks/${operation}`,
          headers: authHeaders,
          payload,
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      }
      async function inspect(requestId) {
        let cursor = 0,
          snapshot,
          serialized = '';
        do {
          const page = await callback('content-modification/read', {
            requestId,
            view: 'overview',
            cursor,
            ...(snapshot ? { expectedSnapshot: snapshot } : {}),
          });
          serialized += page.json;
          snapshot = page.snapshot;
          cursor = page.nextCursor;
        } while (cursor !== null);
        return JSON.parse(serialized);
      }
      async function takeOver(messageId) {
        const result = await callback('content-modification/take-over', {
          sourceMessageId: messageId,
          operationId: randomUUID(),
        });
        await artifacts.dispatcher.drain();
        const view = await integration.requests.read(result.record.requestId, human);
        assert.ok(view.execution?.messageId, 'production return created its actual queue carrier');
        await driver.waitForAwakening(view.execution.messageId);
        return result.record;
      }
      return {
        app,
        nativeMediaRoutes: media,
        workspaceSource: content.source,
        fileReviewStore: content.store,
        messages,
        threads,
        thread,
        tasks,
        catId,
        integration,
        artifacts,
        driver,
        human,
        errors,
        events,
        callback,
        inspect,
        takeOver,
        headers,
        fileQuotes: { source: content.source, messages, threads },
        async close() {
          await driver.close();
          integration.writer.close();
          artifacts.store.close();
        },
      };
    },
  });
}
