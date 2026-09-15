import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { InvocationRegistry } from '../../../../api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { ThreadStore } from '../../../../api/src/domains/cats/services/stores/ports/ThreadStore.ts';
import { registerCallbackAuthHook } from '../../../../api/src/routes/callback-auth-prehandler.ts';
import { registerCallbackContentEditorRoutes } from '../../../../api/src/routes/callback-content-editor-routes.ts';
import { editorLayout } from './f309-editor-layout.mjs';

/** Separate process and registered cat credentials; no human bearer or page is used. */
export async function registerNamedCatJourney(app, content, ownerUserId, scratch) {
  const registry = new InvocationRegistry();
  const threads = new ThreadStore();
  const thread = threads.create(ownerUserId, 'Independent document acceptance');
  const credentials = await registry.create(ownerUserId, 'codex-astra', thread.id);
  registerCallbackAuthHook(app, registry);
  registerCallbackContentEditorRoutes(app, { holder: { current: content.namedCats }, threadStore: threads });
  const toolsUrl = new URL('../../../../mcp-server/dist/tools/content-editor-tools.js', import.meta.url).href;
  const childScript = `const chunks=[]; for await(const chunk of process.stdin)chunks.push(chunk); const {operation,input}=JSON.parse(Buffer.concat(chunks)); const m=await import(${JSON.stringify(toolsUrl)}); const result=await m[operation==='inspect'?'handleInspectOfficeDocument':'handleEditOfficeDocument'](input); if(result.isError)throw new Error(result.content.map(c=>c.text).join('')); process.stdout.write(result.content.map(c=>c.text).join(''));`;
  return async function journey({
    apiOrigin,
    parentOrigin,
    context,
    contentRef: expectedContentRef,
    evidence,
    observe,
  }) {
    assert.equal(context.pages().length, 0, 'all human tabs must be closed before the cat acts');
    const call = (operation, input) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          process.execPath,
          ['--input-type=module', '-e', childScript],
          {
            cwd: scratch,
            maxBuffer: 64 * 1024,
            timeout: 35_000,
            env: {
              PATH: process.env.PATH,
              CAT_CAFE_API_URL: apiOrigin,
              CAT_CAFE_INVOCATION_ID: credentials.invocationId,
              CAT_CAFE_CALLBACK_TOKEN: credentials.callbackToken,
              CAT_CAFE_CALLBACK_OUTBOX_DIR: path.join(scratch, 'mcp-outbox'),
            },
          },
          (error, stdout, stderr) =>
            error ? reject(new Error(`Independent MCP call failed: ${stderr}`)) : resolve(JSON.parse(stdout)),
        );
        child.stdin.end(JSON.stringify({ operation, input }));
      });
    await assert.rejects(
      call('inspect', { workspace: { worktreeId: 'genoffice-acceptance', path: 'never-opened.docx' } }),
      /Document not found/,
    );
    const initial = await call('inspect', {
      workspace: { worktreeId: 'genoffice-acceptance', path: 'sample.docx' },
      limit: 8,
      maxChars: 12000,
    });
    assert.equal(initial.status, 'ready');
    const contentRef = initial.contentRef;
    assert.equal(contentRef, expectedContentRef);
    const inspect = (expectedOwnerRevision) =>
      call('inspect', {
        contentRef,
        cursor: 0,
        limit: 8,
        maxChars: 12000,
        ...(expectedOwnerRevision ? { expectedOwnerRevision } : {}),
      });
    const target = initial.paragraphs.find((row) => row.editable).target;
    const replacement = `${target.textQuote} — 具名猫独立修订`;
    const editInput = {
      contentRef,
      expectedOwnerRevision: initial.ownerRevision,
      operationId: 'named-cat-tracked-1',
      operation: { kind: 'tracked-change', target, replacement },
    };
    const changed = await call('edit', editInput);
    assert.equal(changed.status, 'applied');
    assert.deepEqual(changed.receipt.actor, { kind: 'cat', actorId: 'codex-astra' });
    assert.deepEqual(
      (await call('edit', editInput)).receipt,
      changed.receipt,
      'replay must reuse the exact owner receipt',
    );
    const stale = await call('edit', {
      contentRef,
      expectedOwnerRevision: initial.ownerRevision,
      operationId: 'named-cat-stale',
      operation: { kind: 'comment', target, body: 'Stale comment must not settle' },
    });
    assert.equal(stale.status, 'conflict');
    const reread = await inspect(changed.receipt.ownerRevision);
    const changedTarget = reread.paragraphs.find((row) => row.target.textQuote === replacement).target;
    const commentText = '这条批注来自独立的 codex-astra 会话。';
    const commented = await call('edit', {
      contentRef,
      expectedOwnerRevision: reread.ownerRevision,
      operationId: 'named-cat-comment-1',
      operation: { kind: 'comment', target: changedTarget, body: commentText },
    });
    assert.equal(commented.status, 'applied');
    assert.deepEqual(commented.receipt.actor, { kind: 'cat', actorId: 'codex-astra' });
    const current = await content.owner.load(contentRef);
    assert.equal(current.ownerRevision, initial.ownerRevision + 2);
    const destination = path.join(evidence, 'named-cat-edited.docx');
    await writeFile(destination, current.bytes);
    const script =
      'import sys,json,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); ns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}; doc=E.fromstring(z.read("word/document.xml")); comments=E.fromstring(z.read("word/comments.xml")); key="{"+ns["w"]+"}author"; print(json.dumps({"insertAuthors":[e.get(key) for e in doc.findall(".//w:ins",ns)],"deleteAuthors":[e.get(key) for e in doc.findall(".//w:del",ns)],"commentAuthors":[e.get(key) for e in comments.findall("w:comment",ns)],"commentText":"".join(comments.itertext()),"tables":len(doc.findall(".//w:tbl",ns)),"drawings":len(doc.findall(".//w:drawing",ns))}))';
    const { stdout } = await promisify(execFile)('python3', ['-c', script, destination]);
    const markup = JSON.parse(stdout);
    for (const authors of [markup.insertAuthors, markup.deleteAuthors, markup.commentAuthors])
      assert.ok(authors.includes('codex-astra'));
    assert.ok(markup.commentText.includes(commentText));
    const page = await context.newPage();
    observe(page);
    try {
      await page.goto(parentOrigin);
      await page.getByTestId('content-editor-connected').waitFor();
      const frame = page.frames().find((row) => new URL(row.url()).hostname.endsWith('.localhost'));
      assert.ok(frame);
      await frame.getByText(replacement, { exact: true }).waitFor();
      assert.ok((await editorLayout(frame)).visible);
      await page.screenshot({ path: path.join(evidence, 'named-cat-reopened.png'), fullPage: true });
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, 'named-cat-failure.png'), fullPage: true });
      await writeFile(path.join(evidence, 'named-cat-failure.html'), await page.content());
      throw error;
    }
    const result = {
      independentProcess: true,
      workspaceLocatorResolvedByHost: true,
      unopenedDocumentNotImported: true,
      noHumanTabDuringMutation: true,
      actor: 'codex-astra',
      initialOwnerRevision: initial.ownerRevision,
      changed: changed.receipt,
      commented: commented.receipt,
      replaySameReceipt: true,
      staleRejected: true,
      markup,
    };
    await writeFile(path.join(evidence, 'named-cat-result.json'), JSON.stringify(result, null, 2));
    return result;
  };
}
