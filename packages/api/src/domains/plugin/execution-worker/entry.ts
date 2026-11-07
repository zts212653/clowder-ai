import { pathToFileURL } from 'node:url';
import { type MessagePort, parentPort } from 'node:worker_threads';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { moduleActivation } from './module-values.js';
import { TeardownRemoteValue } from './protocol.js';
import { ExecutionRpcPeer } from './rpc-peer.js';

interface Definition {
  start: (...args: unknown[]) => unknown;
  preStart?: (...args: unknown[]) => unknown;
  settings?: (...args: unknown[]) => unknown;
  preUninstall?: (...args: unknown[]) => unknown;
  uninstall?: (...args: unknown[]) => unknown;
}

function definition(value: unknown): Definition {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'Module create() must return a definition');
  return value as Definition;
}

parentPort?.on('message', (message: { kind: 'open'; port: MessagePort; synchronousState: SharedArrayBuffer }) => {
  if (message.kind !== 'open') return;
  const peer = new ExecutionRpcPeer(message.port, { synchronousState: message.synchronousState });
  peer.expose('definition', async (path, manifest) => {
    const entrypoint = String(path);
    const namespace = await import(pathToFileURL(entrypoint).href);
    if (typeof namespace.default?.create !== 'function')
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'Module must default-export create()');
    const created = definition(await namespace.default.create(structuredClone(manifest as PluginManifest)));
    const methods = ['start', 'preStart', 'settings', 'preUninstall', 'uninstall'] as const;
    return Object.fromEntries(
      methods
        .filter((key) => typeof created[key] === 'function')
        .map((key) => {
          const invoke = async (...args: unknown[]) => {
            const result = await Reflect.apply(created[key] as (...input: unknown[]) => unknown, created, args);
            return key === 'start' || key === 'settings' ? moduleActivation(result) : result;
          };
          return [key, key === 'uninstall' || key === 'preUninstall' ? new TeardownRemoteValue(invoke) : invoke];
        }),
    );
  });
  peer.expose('factory', async (path, exportName, client) => {
    const namespace = await import(pathToFileURL(String(path)).href);
    const factory = namespace[String(exportName)];
    if (typeof factory !== 'function')
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'MCP factory export unavailable');
    const server = await factory(client);
    if (typeof server?.connect !== 'function' || typeof server?.close !== 'function')
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'MCP factory must provide connect/close');
    let transport: Record<string, unknown> | undefined;
    return {
      async connect(host: Record<string, unknown>) {
        transport = { ...host };
        if (typeof host.readSessionId === 'function') {
          Object.defineProperty(transport, 'sessionId', {
            get: () => Reflect.apply(host.readSessionId as () => unknown, host, []),
          });
          delete transport.readSessionId;
        }
        await server.connect(transport);
      },
      async message(...args: unknown[]) {
        if (typeof transport?.onmessage === 'function') await Reflect.apply(transport.onmessage, transport, args);
      },
      async error(error: unknown) {
        if (typeof transport?.onerror === 'function') await Reflect.apply(transport.onerror, transport, [error]);
      },
      closed: new TeardownRemoteValue(async () => {
        if (typeof transport?.onclose === 'function') await Reflect.apply(transport.onclose, transport, []);
      }),
      close: new TeardownRemoteValue(async () => {
        await server.close();
      }),
    };
  });
  peer.expose('factoryProbe', async (path, exportName) => {
    const namespace = await import(pathToFileURL(String(path)).href);
    if (typeof namespace[String(exportName)] !== 'function')
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'MCP factory export unavailable');
  });
});
