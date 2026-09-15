import { createHash } from 'node:crypto';
import { validateDocxMaterializationRequest, validateDocxMaterializationResponse } from '@clowder-ai/plugin-contract';
import type {
  DocxMaterializationRequest,
  DocxMaterializationResponse,
} from '@clowder-ai/plugin-contract/docx-materialization';
import type { ContentEditorPluginRuntime, PluginContentEditorHandle } from '../content-editor-runtime/runtime.js';
import { readBoundedPackageFile } from '../external-runtime/bounded-package-file.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import { runContainedMaterializer } from './browser-runner.js';

export interface MaterializerAuthority {
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
export class ContentMaterializerPluginRuntime {
  private active?: ActiveJob;

  constructor(
    private readonly options: {
      readonly editors: Pick<ContentEditorPluginRuntime, 'resolve' | 'features'>;
      readonly packages: VerifiedPluginPackageLocator;
      readonly run?: typeof runContainedMaterializer;
    },
  ) {}

  async abortAndWait(id: string): Promise<void> {
    const job = this.active;
    if (!job || job.id !== id) return;
    job.controller.abort(new Error('materializer authority revoked'));
    await job.done;
  }

  async execute(authority: MaterializerAuthority, request: DocxMaterializationRequest) {
    if (!validateDocxMaterializationRequest(request)) throw new Error('invalid public materializer request');
    if (this.active) throw new Error('materializer busy');
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
        throw new Error('materializer authority changed');
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
        throw new Error('semantic materializer unavailable');
      const operation = request.operation.kind;
      if (operation !== 'inspect' && !handle.contribution.operations.includes(operation))
        throw new Error('semantic operation not admitted');
      pkg = await this.options.packages.resolveInstalledPackage(handle.packageDigest);
      if (
        pkg.manifest.version !== handle.providerVersion ||
        !pkg.manifest.contributions?.some((value) => JSON.stringify(value) === JSON.stringify(handle.contribution))
      )
        throw new Error('materializer package authority mismatch');
      await current();
      const module = await readBoundedPackageFile(pkg.rootDir, declaration.entrypoint, 16 * 1024 * 1024);
      if (`sha256-${createHash('sha256').update(module).digest('base64')}` !== declaration.integrity)
        throw new Error('materializer integrity mismatch');
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
      const output = await (this.options.run ?? runContainedMaterializer)({
        module,
        requestJson: JSON.stringify(request),
        signal: controller.signal,
      });
      await current();
      const response: unknown = JSON.parse(output.json);
      if (
        !validateDocxMaterializationResponse(response) ||
        response.requestId !== request.requestId ||
        response.protocolVersion !== request.protocolVersion ||
        (response.result.kind !== 'rejected' &&
          response.result.kind !== (operation === 'inspect' ? 'inspection' : 'document'))
      )
        throw new Error('invalid public materializer response');
      return { response: response as DocxMaterializationResponse, metrics: output.metrics };
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
  }
}
