import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProjectContentOwnerService } from '../../src/domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../../src/domains/video-studio/project/asset-index.js';
import { VideoProjectScreeningService } from '../../src/domains/video-studio/project/screening-service.js';
import { VideoProjectService } from '../../src/domains/video-studio/project/service.js';
import { WorkspaceContentSourceService } from '../../src/domains/workspace/workspace-content-source.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './video-project-fixture.js';

export async function screeningFixture() {
  const root = await mkdtemp(join(tmpdir(), 'f326-screening-'));
  const dataDir = join(root, 'data');
  const path = join(root, 'movie.mp4');
  await promisify(execFile)(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x96:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      path,
    ],
    { timeout: 15000 },
  );
  const bytes = await readFile(path);
  const workspace = new WorkspaceContentSourceService({
    ownerUserId: principal.userId,
    resolveWorktreeRoot: async (worktreeId) => {
      if (worktreeId !== 'root') throw new Error('Unregistered root');
      return { root, canonicalWorktreeId: 'root' };
    },
  });
  const owner = new ProjectContentOwnerService({ dataDir });
  const projects = new VideoProjectService({
    owner,
    ownerUserId: principal.userId,
    assets: new VideoProjectAssetIndex({
      resolveRoot: async (rootId) => {
        if (rootId !== 'root') throw new Error('Unregistered root');
        return { root, canonicalWorktreeId: 'root' };
      },
    }),
  });
  const created = await projects.create({ principal, operationId: 'create-project', document: projectDocumentFixture });
  const source = await workspace.describeMedia({ principal, locator: { worktreeId: 'root', path: 'movie.mp4' } });
  const input = { contentRef: created.contentRef, ownerRevision: 1, blobDigest: created.blobDigest };
  const request = {
    principal,
    contentRef: created.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'register-screening',
    id: 'ep0-screening-1',
    title: 'EP0',
    input,
    source: { locator: source.locator, expectedSourceRevision: source.revision },
    mapping: {
      segments: [
        {
          mediaStartPts: source.media.kind === 'video' ? source.media.startTick : 0,
          mediaEndPts: source.media.kind === 'video' ? source.media.startTick + source.media.durationTicks : 1,
          projectStartTick: 0,
          projectEndTick: 30,
          refs: ['render-evidence:actual-test'],
        },
      ],
      frame: {
        displayWidth: source.media.width,
        displayHeight: source.media.height,
        canvasWidth: 1920,
        canvasHeight: 1080,
        rotation: 0 as const,
      },
    },
    refs: ['render-evidence:actual-test'],
  };
  const make = (contentOwner = owner, projectService = projects) =>
    new VideoProjectScreeningService({
      owner: contentOwner,
      projects: projectService,
      workspace,
      appendScreening: (command) => projectService.appendScreening(command),
      now: () => '2026-10-10T00:00:00.000Z',
    });
  return {
    root,
    dataDir,
    path,
    bytes,
    owner,
    projects,
    workspace,
    principal,
    request,
    make,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
