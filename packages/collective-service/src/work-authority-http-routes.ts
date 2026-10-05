import type { ServerResponse } from 'node:http';
import { writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

/** Each producer owns its own Human/endpoint authentication; credentials are never interchangeable. */
export async function routeWorkAuthorityPost(
  store: CollectiveServiceStore,
  pathname: string,
  response: ServerResponse,
  body: Record<string, unknown>,
  credential: string,
) {
  if (pathname === '/api/participation/work-policy/register') {
    writeJson(response, 200, await store.registerCollectiveWorkPolicy(credential, body));
  } else if (pathname === '/api/participation/work-policy/read') {
    writeJson(response, 200, store.readCollectiveWorkPolicy(credential, body));
  } else if (pathname === '/api/participation/work-policy/read-owner') {
    writeJson(response, 200, store.readOwnerCollectiveWorkPolicy(credential, body));
  } else if (pathname === '/api/participation/work-policy/revoke') {
    writeJson(response, 200, await store.revokeCollectiveWorkPolicy(credential, body));
  } else if (pathname === '/api/collaboration/work/accept-agent') {
    writeJson(response, 201, await store.acceptCollectiveWorkAsAgent(credential, body));
  } else if (pathname === '/api/collaboration/work/continue-agent') {
    writeJson(response, 201, await store.continueCollectiveWorkAsAgent(credential, body));
  } else if (pathname === '/api/collaboration/work/source-context') {
    writeJson(response, 200, store.readCollectiveWorkSourceContext(credential, body));
  } else if (pathname === '/api/collaboration/work/routing-context') {
    writeJson(response, 200, store.readCollectiveWorkRoutingContext(credential, body));
  } else if (pathname === '/api/collaboration/work/host-admission') {
    writeJson(response, 200, await store.recordCollectiveWorkHostAdmission(credential, body));
  } else return false;
  return true;
}
