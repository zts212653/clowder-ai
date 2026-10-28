import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isProjectOutputRequest, isProjectOutputResult, type ProjectOutputResult } from '@clowder-ai/plugin-contract';
import { validateProjectPath } from '../../../utils/project-path.js';
import type { FileMessagingMediaLedger } from '../../messaging/media-ledger.js';
import { currentPluginCallContext, withPluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import type { HostMediaSourceImporter } from '../media-source-importer.js';
import { FileOutputOperations } from './file-output-operations.js';
import { operationDirectory, readOutputRecord, writeOutputRecord } from './immutable-output-record.js';
import {
  OutputGenerationUnknown,
  OutputProducerRefused,
  OutputProductionPending,
  PluginOutputDispatch,
} from './output-dispatch.js';
import { ProjectOutputFiles } from './project-output-files.js';

type Produced = Extract<ProjectOutputResult, { state: 'produced' }>;
interface Received {
  readonly hmrId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly receipt: Readonly<Record<string, unknown>>;
}
interface Options {
  readonly root: string;
  readonly importer: Pick<HostMediaSourceImporter, 'import'>;
  readonly ledger: Pick<FileMessagingMediaLedger, 'openVerifiedStream'>;
  readonly threads?: { get(id: string): unknown | Promise<unknown> };
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One neutral admission seam for every entrypoint, with Host-owned files and existing media ownership. */
export class PluginProjectOutputs {
  private readonly store: FileOutputOperations;
  private readonly files: ProjectOutputFiles;
  constructor(private readonly options: Options) {
    this.store = new FileOutputOperations(options.root);
    this.files = new ProjectOutputFiles(options.root);
  }

  async call(
    instanceId: string,
    method: string,
    input: unknown,
    admit: () => Promise<PluginRuntimeAdmission>,
    invoke: (method: string, input: unknown) => Promise<unknown>,
  ) {
    const request = structuredClone(input);
    if (!isProjectOutputRequest(request)) throw new Error('invalid_output_request');
    const caller = currentPluginCallContext(instanceId);
    if (!caller || caller.ownerAuthProvenance !== 'strict') throw new Error('authenticated_output_caller_required');
    const initial = await admit();
    const declaration = initial.packageRecord.manifest.projectOutputs?.find((item) => item.method === method);
    if (!declaration) throw new Error('output_not_declared');
    const source = initial.packageRecord.manifest.contributions?.find(
      (item) => item.type === 'media-source' && item.id === declaration.mediaSourceId,
    );
    if (source?.type !== 'media-source') throw new Error('output_not_declared');
    const thread = await this.options.threads?.get(caller.threadId);
    if (
      !object(thread) ||
      thread.createdBy !== caller.userId ||
      thread.deletedAt ||
      typeof thread.projectPath !== 'string'
    )
      throw new Error('output_project_forbidden');
    const project = await validateProjectPath(thread.projectPath);
    if (!project) throw new Error('output_project_forbidden');
    const operationId = `out_${createHash('sha256')
      .update(JSON.stringify([instanceId, caller.userId, caller.threadId, method, request.requestId]))
      .digest('hex')}`;
    const recordPath = join(await operationDirectory(this.options.root, operationId), 'received.json');
    let produced: Produced | undefined;
    const authorize = async () => {
      await caller.assertCurrent();
      const admission = await admit();
      if (
        admission.instance.lifecycleState !== 'installed' ||
        admission.instance.activationState !== 'enabled' ||
        admission.instance.configReadiness !== 'ready' ||
        admission.instance.packageDigest !== initial.instance.packageDigest
      )
        throw new Error('output_permission_denied');
      const current = await this.options.threads?.get(caller.threadId);
      if (
        !object(current) ||
        current.createdBy !== caller.userId ||
        current.deletedAt ||
        typeof current.projectPath !== 'string' ||
        (await validateProjectPath(current.projectPath)) !== project
      )
        throw new Error('output_project_changed');
      await caller.assertCurrent();
    };
    const observe = async (action: string, parameters: unknown) => {
      await authorize();
      const result = await withPluginCallContext(
        instanceId,
        { ...caller, outputOperation: Object.freeze({ id: operationId }) },
        () => invoke(action, parameters),
      );
      if (!isProjectOutputResult(result)) throw new Error('invalid_output_result');
      if (result.state === 'pending') throw new OutputProductionPending();
      if (result.state === 'rejected') throw new OutputProducerRefused(result.code ?? 'producer_refused');
      if (result.state !== 'produced') throw new OutputGenerationUnknown(result.code);
      if (
        result.media.sourceId !== declaration.mediaSourceId ||
        result.media.mimeType !== declaration.mimeType ||
        result.media.bytes > declaration.maxBytes
      )
        throw new Error('invalid_output_result');
      produced = result;
      return operationId;
    };
    const dispatch = new PluginOutputDispatch({
      store: this.store,
      authorize,
      reserve: () => this.files.reserve(operationId, project, request.outputPath),
      produce: async () => {
        await this.files.verify(operationId);
        return observe(declaration.producerMethod, request.parameters);
      },
      lookupProduced: async () =>
        (await readOutputRecord(recordPath)) ? operationId : observe(declaration.resultMethod, {}),
      accept: async (id, reference) => {
        if (id !== operationId || reference !== operationId) throw new Error('output_source_mismatch');
        if (await readOutputRecord(recordPath)) return;
        if (!produced) throw new Error('output_source_missing');
        const imported = await this.options.importer.import({
          instanceId,
          sourceId: declaration.mediaSourceId,
          sourceEventId: operationId,
          elementId: 'generated-media',
          type: 'audio',
          reference: produced.media.reference,
          ingressIdentity: source.binding,
        });
        if (imported.kind !== 'imported') throw new Error('output_source_unavailable');
        const bytes = await this.read(imported.hmrId, declaration.maxBytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (
          bytes.length !== produced.media.bytes ||
          sha256 !== produced.media.sha256 ||
          !(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1]! & 224) === 224))
        )
          throw new Error('output_media_mismatch');
        await authorize();
        await writeOutputRecord(recordPath, {
          hmrId: imported.hmrId,
          bytes: bytes.length,
          sha256,
          receipt: {
            ...produced.provenance,
            delivery: {
              operationId,
              pluginId: initial.packageRecord.pluginId,
              pluginInstanceId: instanceId,
              packageDigest: initial.instance.packageDigest,
              audioSha256: sha256,
              acceptedAt: new Date().toISOString(),
            },
          },
        } satisfies Received);
      },
      deliver: async (reservation) => {
        const received = (await readOutputRecord(recordPath)) as Received | undefined;
        if (!received) throw new Error('output_source_missing');
        const bytes = await this.read(received.hmrId, declaration.maxBytes);
        if (bytes.length !== received.bytes || createHash('sha256').update(bytes).digest('hex') !== received.sha256)
          throw new Error('output_media_mismatch');
        await authorize();
        await this.files.deliver(reservation, bytes, received.receipt);
      },
    });
    const result = await dispatch.run({
      operationId,
      targetKeys: [resolve(project, request.outputPath), `${resolve(project, request.outputPath)}.provenance.json`],
      parameters: { parameters: request.parameters, declaration },
    });
    return {
      ...result,
      operationId,
      retryable: false,
      ...(result.state === 'delivered'
        ? { outputPath: request.outputPath, provenancePath: `${request.outputPath}.provenance.json` }
        : {}),
    };
  }

  private async read(reference: string, maxBytes: number): Promise<Buffer> {
    const opened = await this.options.ledger.openVerifiedStream(reference);
    if (!opened || opened.byteLength > maxBytes) throw new Error('output_source_unavailable');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of opened.stream) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('output_source_too_large');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally {
      opened.stream.destroy();
    }
  }
}
