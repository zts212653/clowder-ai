import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export function validateInput(input) {
  assert.match(input.runId, /^[1-9]\d{0,15}$/);
  assert.match(input.head, /^[a-f0-9]{40}$/);
  assert.match(input.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(input.repository, 'zts212653/clowder-ai');
}

export function validateProducer(input, run, artifacts, jobs) {
  validateInput(input);
  assert.equal(String(run.id), input.runId);
  assert.equal(run.repository.full_name, input.repository);
  assert.equal(run.head_sha, input.head);
  assert.equal(run.path, '.github/workflows/release-desktop.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.ok(['in_progress', 'completed'].includes(run.status));
  const producers = jobs.filter((job) => job.name === 'Windows Desktop / Windows Installer + Portable');
  assert.equal(producers.length, 1, 'Expected one current Windows producer job');
  const producer = producers[0];
  assert.equal(producer.run_id, run.id);
  assert.equal(producer.run_attempt, run.run_attempt);
  assert.equal(producer.head_sha, input.head);
  assert.equal(producer.status, 'completed');
  assert.equal(producer.conclusion, 'success');
  return ['installer', 'portable'].map((kind) => {
    const matches = artifacts.filter((a) => a.name === `windows-${kind}-${input.version}`);
    assert.equal(matches.length, 1, `Expected exactly one ${kind} artifact`);
    const artifact = matches[0];
    assert.equal(artifact.expired, false);
    assert.equal(String(artifact.workflow_run.id), input.runId);
    assert.equal(artifact.workflow_run.head_sha, input.head);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
    const created = Date.parse(artifact.created_at);
    assert.ok(
      Number.isFinite(created) &&
        created >= Date.parse(producer.started_at) &&
        created <= Date.parse(producer.completed_at),
      'Artifact must come from the current successful producer attempt',
    );
    return { ...artifact, kind };
  });
}

async function gh(endpoint, destination) {
  const child = spawn('gh', ['api', endpoint], { stdio: ['ignore', 'pipe', 'inherit'], shell: false });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`gh api exited ${code}`))));
  });
  await Promise.all([pipeline(child.stdout, fs.createWriteStream(destination, { flags: 'wx' })), exited]);
}

async function main() {
  const input = {
    runId: process.env.PRODUCER_RUN,
    head: process.env.PRODUCER_HEAD,
    version: process.env.CANDIDATE_VERSION,
    repository: process.env.GITHUB_REPOSITORY,
  };
  validateInput(input);
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'f330-candidate-'));
  const evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  fs.appendFileSync(process.env.GITHUB_ENV, `CANDIDATE_ROOT=${root}\n`);
  const base = `repos/${input.repository}/actions`;
  await gh(`${base}/runs/${input.runId}`, path.join(evidence, 'producer.json'));
  await gh(`${base}/runs/${input.runId}/artifacts?per_page=100`, path.join(evidence, 'artifacts.json'));
  await gh(`${base}/runs/${input.runId}/jobs?filter=latest&per_page=100`, path.join(evidence, 'jobs.json'));
  const run = JSON.parse(fs.readFileSync(path.join(evidence, 'producer.json'), 'utf8'));
  const { artifacts, total_count: totalCount } = JSON.parse(
    fs.readFileSync(path.join(evidence, 'artifacts.json'), 'utf8'),
  );
  assert.equal(artifacts.length, totalCount, 'Artifact listing must be complete');
  const { jobs, total_count: jobCount } = JSON.parse(fs.readFileSync(path.join(evidence, 'jobs.json'), 'utf8'));
  assert.equal(jobs.length, jobCount, 'Producer job listing must be complete');
  const selected = validateProducer(input, run, artifacts, jobs);
  const downloaded = [];
  for (const artifact of selected) {
    const destination = path.join(root, `${artifact.kind}-artifact.zip`);
    await gh(`${base}/artifacts/${artifact.id}/zip`, destination);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
    const digest = `sha256:${hash.digest('hex')}`;
    assert.equal(digest, artifact.digest, 'Downloaded bytes differ from GitHub digest');
    downloaded.push({
      id: artifact.id,
      name: artifact.name,
      kind: artifact.kind,
      digest,
      bytes: fs.statSync(destination).size,
    });
  }
  fs.writeFileSync(
    path.join(evidence, 'input-receipt.json'),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        ...input,
        producerAttempt: run.run_attempt,
        producerJob: jobs.find((job) => job.name === 'Windows Desktop / Windows Installer + Portable').id,
        overallProducerStatus: run.status,
        overallProducerConclusion: run.conclusion,
        verifierHead: process.env.GITHUB_SHA,
        downloaded,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, head: input.head, version: input.version, verifiedArtifacts: downloaded.length }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
