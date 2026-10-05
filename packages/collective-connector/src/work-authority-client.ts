import {
  type CollectiveAcceptWorkRequest,
  type CollectiveContinueWorkRequest,
  type CollectiveRevokeWorkPolicyRequest,
  type CollectiveWorkHostAdmissionRequest,
  type CollectiveWorkRoutingReadRequest,
  type CollectiveWorkSourceReadRequest,
  collectiveWorkPolicySchema,
  collectiveWorkProjectionSchema,
  collectiveWorkSourceContextSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

type Coordinates = { serviceInstanceId: string; collectiveId: string; connectionId: string };
type Request = (
  serviceUrl: string,
  path: string,
  options: { method: 'POST'; credential: string; body: unknown },
) => Promise<Record<string, unknown>>;

/** Endpoint transport deliberately has no owner-registration command. */
export class CollectiveWorkAuthorityClient {
  constructor(private readonly request: Request) {}

  async readPolicy(serviceUrl: string, credential: string, input: Coordinates) {
    const value = await this.request(serviceUrl, '/api/participation/work-policy/read', {
      method: 'POST',
      credential,
      body: input,
    });
    return z.object({ policy: collectiveWorkPolicySchema.nullable() }).strict().parse(value).policy;
  }

  async revokePolicy(serviceUrl: string, credential: string, input: CollectiveRevokeWorkPolicyRequest) {
    return collectiveWorkPolicySchema.parse(
      await this.request(serviceUrl, '/api/participation/work-policy/revoke', {
        method: 'POST',
        credential,
        body: input,
      }),
    );
  }

  async acceptWork(serviceUrl: string, credential: string, input: CollectiveAcceptWorkRequest) {
    return collectiveWorkProjectionSchema.parse(
      await this.request(serviceUrl, '/api/collaboration/work/accept-agent', {
        method: 'POST',
        credential,
        body: input,
      }),
    );
  }

  async continueWork(serviceUrl: string, credential: string, input: CollectiveContinueWorkRequest) {
    return collectiveWorkProjectionSchema.parse(
      await this.request(serviceUrl, '/api/collaboration/work/continue-agent', {
        method: 'POST',
        credential,
        body: input,
      }),
    );
  }
  async readSourceContext(serviceUrl: string, credential: string, input: CollectiveWorkSourceReadRequest) {
    return collectiveWorkSourceContextSchema.parse(
      await this.request(serviceUrl, '/api/collaboration/work/source-context', {
        method: 'POST',
        credential,
        body: input,
      }),
    );
  }
  async readRoutingContext(serviceUrl: string, credential: string, input: CollectiveWorkRoutingReadRequest) {
    return collectiveWorkSourceContextSchema.parse(
      await this.request(serviceUrl, '/api/collaboration/work/routing-context', {
        method: 'POST',
        credential,
        body: input,
      }),
    );
  }

  async recordHostAdmission(serviceUrl: string, credential: string, input: CollectiveWorkHostAdmissionRequest) {
    return collectiveWorkProjectionSchema.parse(
      await this.request(serviceUrl, '/api/collaboration/work/host-admission', {
        method: 'POST',
        credential,
        body: input,
      }),
    );
  }
}
