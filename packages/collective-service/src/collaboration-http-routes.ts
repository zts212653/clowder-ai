import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireBearer, writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';
import { routeWorkAuthorityPost } from './work-authority-http-routes.js';

export async function routeCollaborationPost(
  store: CollectiveServiceStore,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  const credential = requireBearer(request);
  if (await routeWorkAuthorityPost(store, pathname, response, body, credential)) return true;
  if (await routeVotePost(store, pathname, response, body, credential)) return true;
  if (pathname === '/api/collaboration/reactions/set') {
    writeJson(response, 200, await store.setCollectiveReaction(credential, body));
  } else if (pathname === '/api/collaboration/work/propose') {
    writeJson(response, 201, await store.proposeCollectiveWork(credential, body));
  } else if (pathname === '/api/collaboration/work/propose-agent') {
    writeJson(response, 201, await store.proposeCollectiveWorkAsAgent(credential, body));
  } else if (pathname === '/api/collaboration/work/commit') {
    writeJson(response, 200, await store.commitCollectiveWork(credential, body));
  } else if (pathname === '/api/collaboration/work/dependencies') {
    writeJson(response, 200, await store.setCollectiveWorkDependencies(credential, body));
  } else if (pathname === '/api/collaboration/work/decline') {
    writeJson(response, 200, await store.declineCollectiveWork(credential, body));
  } else if (pathname === '/api/collaboration/work/result/accept') {
    writeJson(response, 200, await store.acceptCollectiveWorkResult(credential, body));
  } else if (pathname === '/api/collaboration/work/result/revision') {
    writeJson(response, 200, await store.requestCollectiveWorkRevision(credential, body));
  } else if (pathname === '/api/collaboration/work/complete') {
    writeJson(response, 200, await store.completeCollectiveWork(credential, body));
  } else if (pathname === '/api/collaboration/roadmaps') {
    writeJson(response, 201, await store.createCollectiveRoadmap(credential, body));
  } else if (pathname === '/api/collaboration/roadmaps/works') {
    writeJson(response, 200, await store.setCollectiveRoadmapWorks(credential, body));
  } else if (pathname === '/api/collaboration/roadmaps/status') {
    writeJson(response, 200, await store.setCollectiveRoadmapStatus(credential, body));
  } else {
    return false;
  }
  return true;
}

async function routeVotePost(
  store: CollectiveServiceStore,
  pathname: string,
  response: ServerResponse,
  body: Record<string, unknown>,
  credential: string,
): Promise<boolean> {
  if (pathname === '/api/collaboration/votes') {
    writeJson(response, 201, await store.createCollectiveVote(credential, body));
  } else if (pathname === '/api/collaboration/votes/cast') {
    writeJson(response, 200, await store.castCollectiveVote(credential, body));
  } else if (pathname === '/api/collaboration/votes/close') {
    writeJson(response, 200, await store.closeCollectiveVote(credential, body));
  } else if (pathname === '/api/collaboration/binding-votes') {
    writeJson(response, 201, await store.createCollectiveBindingVote(credential, body));
  } else if (pathname === '/api/collaboration/binding-votes/cast') {
    writeJson(response, 200, await store.castCollectiveBindingVote(credential, body));
  } else if (pathname === '/api/collaboration/binding-votes/withdraw') {
    writeJson(response, 200, await store.withdrawCollectiveBindingVote(credential, body));
  } else if (pathname === '/api/collaboration/binding-votes/settle') {
    writeJson(response, 200, await store.settleCollectiveBindingVote(credential, body));
  } else {
    return false;
  }
  return true;
}
