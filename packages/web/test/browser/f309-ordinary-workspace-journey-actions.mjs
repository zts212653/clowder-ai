import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveFileSourceResponse } from './f307-real-surface-fixtures.mjs';
import {
  fixtureForApi,
  json,
  REVIEW_ID,
  reviewView,
  SOURCE_REVISION,
  WORKTREE_ID,
} from './f309-ordinary-workspace-journey-fixture.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

function applyAnnotation(state, payload) {
  state.revision += 1;
  state.annotations.push({
    id: 'ordinary-annotation',
    anchor: { baseRevision: state.fixture.revision, anchor: payload.target.anchor },
    body: payload.body,
    author: { kind: 'human', actorId: 'operator' },
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    state: 'open',
    replies: [],
  });
}

function applyAction(state, action) {
  state.revision += 1;
  if (action.kind === 'add_visual_marks') {
    state.visualMarks.push(
      ...action.marks.map((drawing) => ({
        drawing,
        baseRevision: state.fixture.revision,
        author: { kind: 'human', actorId: 'operator' },
        createdAt: '2026-09-18T00:00:00.000Z',
        state: 'active',
      })),
    );
    return;
  }
  const annotation = state.annotations.find((item) => item.id === action.annotationId);
  if (!annotation) return;
  if (action.kind === 'reply') {
    annotation.replies.push({
      id: action.replyId,
      body: action.body,
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-09-18T00:01:00.000Z',
      updatedAt: '2026-09-18T00:01:00.000Z',
    });
    return;
  }
  if (action.kind === 'set_annotation_state') annotation.state = action.state;
}

async function fulfillBinaryMedia(route, url, state) {
  const mediaPath = `/api/workspace/content-reviews/${REVIEW_ID}/media`;
  if (url.pathname !== mediaPath && url.pathname !== '/api/workspace/file/raw') return false;
  const range = await route.request().headerValue('range');
  const size = state.fixture.bytes.length;
  const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
  if (match) {
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
    if (start >= size || end < start) {
      await route.fulfill({ status: 416, headers: { 'content-range': `bytes */${size}` } });
      return true;
    }
    const body = state.fixture.bytes.subarray(start, end + 1);
    await route.fulfill({
      status: 206,
      contentType: state.fixture.mime,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${end}/${size}`,
      },
      body,
    });
    return true;
  }
  await route.fulfill({
    status: 200,
    contentType: state.fixture.mime,
    headers: { 'accept-ranges': 'bytes', 'content-length': String(size) },
    body: state.fixture.bytes,
  });
  return true;
}

async function fulfillReviewRead(route, url, state) {
  const request = route.request();
  const isPrepare = url.pathname === '/api/workspace/content-reviews/prepare';
  const isRead = url.pathname === `/api/workspace/content-reviews/${REVIEW_ID}` && request.method() === 'GET';
  if (!isPrepare && !isRead) return false;
  await json(route, reviewView(state));
  return true;
}

async function fulfillReviewMutation(route, url, state, actionKinds) {
  if (url.pathname === `/api/workspace/content-reviews/${REVIEW_ID}/annotations`) {
    applyAnnotation(state, route.request().postDataJSON());
    await json(route, {});
    return true;
  }
  if (url.pathname !== `/api/workspace/content-reviews/${REVIEW_ID}/actions`) return false;
  const payload = route.request().postDataJSON();
  actionKinds.push(payload.action.kind);
  applyAction(state, payload.action);
  await json(route, {});
  return true;
}

function searchTypeFor(request, url) {
  if (url.pathname !== '/api/workspace/search' || request.method() !== 'POST') return undefined;
  return request.postDataJSON()?.type;
}

export async function fulfillFixtureApi(route, state, actionKinds) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/debug/callback-auth') {
    await json(route, { error: 'forbidden' }, 403);
    return;
  }
  if (url.pathname === '/api/workspace/resolve-file-source' && route.request().method() === 'POST') {
    const response = resolveFileSourceResponse(route.request(), [WORKTREE_ID]);
    await json(route, response.body, response.status);
    return;
  }
  if (await fulfillBinaryMedia(route, url, state)) return;
  if (await fulfillReviewRead(route, url, state)) return;
  if (await fulfillReviewMutation(route, url, state, actionKinds)) return;
  await json(route, fixtureForApi(url, searchTypeFor(route.request(), url), state));
}

export async function ordinaryVideoFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'f309-ordinary-video-'));
  try {
    const name = await mediaFixture(root, 'mp4');
    return {
      filePath: 'art/clip.mp4',
      fileName: 'clip.mp4',
      revision: SOURCE_REVISION,
      mime: 'video/mp4',
      bytes: await readFile(path.join(root, name)),
      media: {
        kind: 'video',
        width: 640,
        height: 360,
        codedWidth: 640,
        codedHeight: 360,
        rotation: 0,
        pixelAspectRatio: { numerator: 1, denominator: 1 },
        streamId: 'ordinary-video-stream',
        streamIndex: 0,
        timebase: { numerator: 1, denominator: 1000 },
        startTick: 0,
        durationTicks: 3000,
        containerStartSeconds: 0,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
