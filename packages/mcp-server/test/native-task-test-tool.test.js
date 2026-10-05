import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleNativeTaskTest } from '../dist/tools/native-task-test-tool.js';

test(
  'native MCP test tool takes no model command and consumes one callback-authorized target',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-test-tool-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'task.test.mjs'), "import { test } from 'node:test'; test('approved', () => {});\n");
    const credentialFile = join(root, 'credential.json');
    writeFileSync(credentialFile, JSON.stringify({ invocationId: 'inv-test', callbackToken: 'FAKE-TOKEN' }));
    let observedRequests = 0;
    const server = createServer((request, response) => {
      observedRequests++;
      assert.equal(request.url, '/api/callbacks/native-test-grant');
      assert.equal(request.headers['x-invocation-id'], 'inv-test');
      assert.equal(request.headers['x-callback-token'], 'FAKE-TOKEN');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ v: 1, taskId: 'task-pilot', workspaceRoot: workspace, testFile: 'task.test.mjs' }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const savedApiUrl = process.env.CAT_CAFE_API_URL;
    const savedCredentialFile = process.env.CAT_CAFE_CREDENTIAL_FILE;
    const savedNativeTurn = process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
    try {
      process.env.CAT_CAFE_API_URL = `http://127.0.0.1:${address.port}/`;
      process.env.CAT_CAFE_CREDENTIAL_FILE = credentialFile;
      delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
      const result = await handleNativeTaskTest({ command: 'rm -rf /', cwd: '/' });
      assert.equal(result.isError, undefined, result.content[0].text);
      const receipt = JSON.parse(result.content[0].text);
      assert.equal(receipt.status, 'passed');
      assert.equal(receipt.taskId, 'task-pilot');
      assert.equal(observedRequests, 1);
      assert.ok(!result.content[0].text.includes('FAKE-TOKEN'));
      writeFileSync(
        join(workspace, 'task.test.mjs'),
        "import { test } from 'node:test'; test('failing', () => { throw new Error('red'); });\n",
      );
      const redResult = await handleNativeTaskTest({});
      assert.equal(redResult.isError, undefined, redResult.content[0].text);
      assert.equal(JSON.parse(redResult.content[0].text).status, 'failed');
      assert.equal(observedRequests, 2);
    } finally {
      if (savedApiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
      else process.env.CAT_CAFE_API_URL = savedApiUrl;
      if (savedCredentialFile === undefined) delete process.env.CAT_CAFE_CREDENTIAL_FILE;
      else process.env.CAT_CAFE_CREDENTIAL_FILE = savedCredentialFile;
      if (savedNativeTurn === undefined) delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
      else process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE = savedNativeTurn;
      await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
