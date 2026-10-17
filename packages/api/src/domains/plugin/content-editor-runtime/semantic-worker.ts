import { createHash } from 'node:crypto';
import { readBoundedPackageFile } from '../external-runtime/bounded-package-file.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { ContentEditorPluginRuntime, PluginContentEditorHandle } from './runtime.js';
import { runContainedEditorWorker } from './semantic-browser-runner.js';
import { type EditorWorkerRequest, editorWorkerRequest, editorWorkerResponse } from './semantic-worker-protocol.js';

export interface EditorWorkerAuthority {
  readonly installationInstanceId: string;
  readonly providerId: string;
  readonly packageDigest: string;
  readonly providerVersion: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly executionLeaseDigest: string;
}

interface ActiveJob {
  readonly id: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/** F202 compute consumer of the existing feature authority. No new install,
 * activation or owner-effect API. Only one private process tree runs per Host.
 */
export class ContentEditorSemanticWorker {
  private active?: ActiveJob;

  constructor(
    private readonly options: {
      readonly editors: Pick<ContentEditorPluginRuntime, 'resolve' | 'features'>;
      readonly packages: VerifiedPluginPackageLocator;
      readonly run?: typeof runContainedEditorWorker;
    },
  ) {}

  async abortAndWait(id: string): Promise<void> {
    const job = this.active;
    if (!job || job.id !== id) return;
    job.controller.abort(new Error('editor worker authority revoked'));
    await job.done;
  }

  async execute(expectedAuthority: EditorWorkerAuthority, input: EditorWorkerRequest) {
    const parsed = editorWorkerRequest.safeParse(input);
    if (!parsed.success) throw new Error('invalid editor worker request');
    const request = parsed.data;
    const authority = { ...expectedAuthority };
    if (this.active) throw new Error('editor worker busy');
    const controller = new AbortController();
    let complete: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const job: ActiveJob = { id: authority.installationInstanceId, controller, done };
    this.active = job;
    let pkg: VerifiedPluginPackage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> = Promise.resolve();
    let stopped = false;
    let result: {
      response: ReturnType<typeof editorWorkerResponse.parse>;
      metrics: Awaited<ReturnType<typeof runContainedEditorWorker>>['metrics'];
    };
    const current = async (): Promise<PluginContentEditorHandle> => {
      controller.signal.throwIfAborted();
      const handle = await this.options.editors.resolve(authority.installationInstanceId, authority.providerId);
      if (
        !handle ||
        handle.packageDigest !== authority.packageDigest ||
        handle.providerVersion !== authority.providerVersion ||
        handle.grantRevision !== authority.grantRevision ||
        handle.lifecycleRevision !== authority.lifecycleRevision ||
        `sha256:${createHash('sha256').update(handle.executionLease).digest('hex')}` !== authority.executionLeaseDigest
      )
        throw new Error('editor worker authority changed');
      await this.options.editors.features.run(handle.executionLease, async () => undefined);
      await pkg?.verifyIntegrity();
      controller.signal.throwIfAborted();
      return handle;
    };
    try {
      const handle = await current();
      const declaration = handle.contribution.semanticMaterializer;
      if (
        !declaration ||
        declaration.executionClass !== 'dedicated-browser-worker' ||
        declaration.protocolVersion !== request.protocolVersion
      )
        throw new Error('semantic editor worker unavailable');
      if (!handle.contribution.mediaTypes.some((mediaType) => mediaType === request.mediaType))
        throw new Error('editor media type not admitted');
      const operation = request.operation.kind;
      if (operation !== 'inspect' && !handle.contribution.operations.includes(operation))
        throw new Error('semantic operation not admitted');
      pkg = await this.options.packages.resolveInstalledPackage(handle.packageDigest);
      if (
        pkg.manifest.version !== handle.providerVersion ||
        !pkg.manifest.contributions?.some((value) => JSON.stringify(value) === JSON.stringify(handle.contribution))
      )
        throw new Error('editor worker package authority mismatch');
      await current();
      const module = await readBoundedPackageFile(pkg.rootDir, declaration.entrypoint, 16 * 1024 * 1024);
      if (`sha256-${createHash('sha256').update(module).digest('base64')}` !== declaration.integrity)
        throw new Error('editor worker integrity mismatch');
      await current();
      const schedule = () => {
        timer = setTimeout(() => {
          pending = current()
            .then(() => undefined)
            .catch((error) => controller.abort(error))
            .finally(() => {
              if (!stopped && !controller.signal.aborted) schedule();
            });
        }, 200);
        timer.unref();
      };
      schedule();
      const output = await (this.options.run ?? runContainedEditorWorker)({
        module,
        requestJson: JSON.stringify(request),
        signal: controller.signal,
      });
      await current();
      const validated = editorWorkerResponse.safeParse(JSON.parse(output.json));
      const response = validated.success ? validated.data : undefined;
      if (
        !response ||
        response.requestId !== request.requestId ||
        response.protocolVersion !== request.protocolVersion ||
        (response.result.kind !== 'rejected' &&
          response.result.kind !== (operation === 'inspect' ? 'inspection' : 'document'))
      )
        throw new Error('invalid public editor worker response');
      result = { response, metrics: output.metrics };
    } finally {
      stopped = true;
      clearTimeout(timer);
      await pending;
      try {
        await pkg?.release();
      } finally {
        if (this.active === job) this.active = undefined;
        complete();
      }
    }
    // Cleanup is asynchronous and remains revocable. Publish only after it has
    // closed, with no await between this final fence and the returned result.
    controller.signal.throwIfAborted();
    return result;
  }
}
