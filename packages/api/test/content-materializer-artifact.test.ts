import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runContainedMaterializer } from '../src/domains/plugin/content-materializer-runtime/browser-runner.js';

test(
  'actual packed GenOffice worker inspects and edits DOCX in the contained browser',
  { timeout: 60_000 },
  async (t) => {
    const archive = process.env.F309_SEMANTIC_ARCHIVE;
    const expected = process.env.F309_SEMANTIC_ARCHIVE_SRI;
    const fixture = process.env.GENOFFICE_DOCX_FIXTURE;
    assert.ok(archive && expected && fixture, 'explicit canonical artifact coordinates and genuine DOCX required');
    const bytes = await readFile(archive);
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, expected);
    const directory = await mkdtemp(join(tmpdir(), 'f309-contained-artifact-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await promisify(execFile)('tar', ['-xzf', archive, '-C', directory]);
    const manifest = JSON.parse(await readFile(join(directory, 'package/manifest.json'), 'utf8'));
    const declaration = manifest.contributions[0].semanticMaterializer;
    assert.equal(declaration.entrypoint, 'renderer/semantic-worker.js');
    const module = await readFile(join(directory, 'package/renderer/semantic-worker.js'));
    assert.equal(`sha256-${createHash('sha256').update(module).digest('base64')}`, declaration.integrity);
    const request = {
      protocolVersion: '1.0.0',
      requestId: 'real-contained-fixture',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytesBase64: (await readFile(fixture)).toString('base64'),
      operation: { kind: 'inspect', cursor: 0, limit: 4 },
    };
    const inspected = await runContainedMaterializer({
      module,
      requestJson: JSON.stringify(request),
      signal: new AbortController().signal,
    });
    const inspection = JSON.parse(inspected.json);
    assert.equal(inspection.result.kind, 'inspection');
    const target = inspection.result.paragraphs.find((row: { editable: boolean }) => row.editable).target;
    const edited = await runContainedMaterializer({
      module,
      requestJson: JSON.stringify({
        ...request,
        operation: {
          kind: 'tracked-change',
          target,
          replacement: '独立安全修订',
          attribution: { author: 'codex-astra', operationId: 'contained-op', timestamp: '2026-09-06T00:00:00.000Z' },
        },
      }),
      signal: new AbortController().signal,
    });
    const changed = JSON.parse(edited.json);
    assert.equal(changed.result.kind, 'document');
    const reopened = await runContainedMaterializer({
      module,
      requestJson: JSON.stringify({ ...request, bytesBase64: changed.result.bytesBase64 }),
      signal: new AbortController().signal,
    });
    assert.ok(
      JSON.parse(reopened.json).result.paragraphs.some(
        (row: { target: { textQuote: string } }) => row.target.textQuote === '独立安全修订',
      ),
    );
    process.stdout.write(
      `${JSON.stringify({ inspect: inspected.metrics, edit: edited.metrics, reopen: reopened.metrics })}\n`,
    );
  },
);
