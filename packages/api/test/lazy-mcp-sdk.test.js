import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(path.join(root, 'package.json'))('esbuild');

test('inactive MCP consumers defer the official SDK and active HTTP/stdio keep identity and recovery', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-mcp-sdk-'));
  try {
    await build({
      stdin: {
        contents: [
          'export {probeMcpCapability} from "./src/routes/mcp-probe.ts";',
          'export {StdioMcpContributionRuntime} from "./src/domains/plugin/manager/builtin-contribution-supervisor.ts";',
        ].join('\n'),
        resolveDir: root,
      },
      outfile: path.join(fixture, 'services.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['@modelcontextprotocol/sdk/*'],
      plugins: [
        {
          name: 'inactive-pencil-resolver',
          setup(builder) {
            builder.onResolve({ filter: /capabilities\/capability-orchestrator\.js$/ }, () => ({
              path: 'pencil',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: 'export async function resolvePencilCommand(){return undefined;}',
            }));
          },
        },
      ],
    });
    fs.writeFileSync(path.join(fixture, 'run.mjs'), consumer);
    for (const delayed of [true, false]) {
      const result = execFileSync(process.execPath, [path.join(fixture, 'run.mjs')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, MCP_FIXTURE_API_ROOT: root, MCP_FIXTURE_LOAD_DELAY: delayed ? '1' : '' },
      });
      assert.match(result, /official lazy MCP consumers passed/);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

const consumer = String.raw`
import assert from 'node:assert/strict';
import http from 'node:http';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const requested=[];
const delayed=process.env.MCP_FIXTURE_LOAD_DELAY==='1';
globalThis.lateClientCreations=0;
let failClient=false;
let failTypes=false;
const clientPath='@modelcontextprotocol/sdk/client/index.js';
registerHooks({
 resolve(specifier,context,next){
  if(!specifier.startsWith('@modelcontextprotocol/sdk/'))return next(specifier,context);
  requested.push(specifier);
  if(specifier===clientPath&&failClient){failClient=false;throw Error('fixture SDK import unavailable');}
  if(specifier==='@modelcontextprotocol/sdk/types.js'&&failTypes){failTypes=false;throw Error('fixture SDK types import unavailable');}
  if(delayed){
   const official=next(specifier,{...context,parentURL:pathToFileURL(process.env.MCP_FIXTURE_API_ROOT+'/package.json').href}).url;
   const names=specifier.endsWith('/types.js')?['McpError','ErrorCode']:specifier.endsWith('/stdio.js')?['StdioClientTransport','getDefaultEnvironment']:['StreamableHTTPClientTransport'];
   const exports=specifier===clientPath?'export class Client extends actual.Client{constructor(...args){super(...args);globalThis.lateClientCreations++;}}':names.map(name=>'export const '+name+'=actual.'+name+';').join('');
   const source='await new Promise(resolve=>setTimeout(resolve,500)); const actual=await import('+JSON.stringify(official)+'); '+exports;
   return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
  }
  return next(specifier,{...context,parentURL:pathToFileURL(process.env.MCP_FIXTURE_API_ROOT+'/package.json').href});
 }
});
const api=await import('./services.mjs');
const runtimeOptions={startTimeoutMs:5000,callTimeoutMs:5000};
const runtime=new api.StdioMcpContributionRuntime(runtimeOptions);
assert.deepEqual(requested,[],'importing routes/constructing an unused runtime must not load the SDK');
if(delayed){
 const options={projectRoot:process.cwd(),timeoutMs:50};
 const idle={command:process.execPath,args:['--eval','process.exit(0)']};
 const started=performance.now();
 const outcomes=await Promise.all([
  api.probeMcpCapability({type:'mcp',mcpServer:{transport:'streamableHttp',url:'http://127.0.0.1:1'}},options),
  api.probeMcpCapability({type:'mcp',mcpServer:idle},options),
  assert.rejects(new api.StdioMcpContributionRuntime({startTimeoutMs:50}).start({...idle,pluginId:'fixture',contributionId:'delay',cwd:process.cwd(),env:{}}),/timed out/)
 ]);
 assert.ok(performance.now()-started<400,'module loading must stay inside the caller timeout');
 for(const result of outcomes.slice(0,2)){assert.equal(result.connectionStatus,'disconnected');assert.match(result.error,/timeout/i);}
 await Promise.all([clientPath,'@modelcontextprotocol/sdk/client/stdio.js','@modelcontextprotocol/sdk/client/streamableHttp.js','@modelcontextprotocol/sdk/types.js'].map(name=>import(name)));
 assert.equal(globalThis.lateClientCreations,0,'late SDK resolution must not start clients after timeout');
 console.log('official lazy MCP consumers passed');
 process.exit(0);
}
const options={projectRoot:process.cwd(),timeoutMs:2000};
assert.deepEqual(await api.probeMcpCapability({type:'skill'},options),{connectionStatus:'unknown'});
assert.deepEqual(await api.probeMcpCapability({type:'mcp'},options),{connectionStatus:'unknown'});
assert.deepEqual(await api.probeMcpCapability({type:'mcp',mcpServer:{command:''}},options),{connectionStatus:'unknown'});
assert.equal((await api.probeMcpCapability({type:'mcp',mcpServer:{transport:'streamableHttp',url:'file:///fixture'}},options)).connectionStatus,'disconnected');
assert.deepEqual(requested,[],'invalid/inactive capabilities must not load the SDK');
let httpRequests=0;
const server=http.createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(405).end();return;}
 let body='';for await(const chunk of req)body+=chunk;
 const message=JSON.parse(body);httpRequests++;
 if(req.headers['x-fixture-mode']==='hang')return;
 if(message.id===undefined){res.writeHead(202).end();return;}
 const result=message.method==='initialize'
  ? {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
  : {tools:[{name:'echo',description:' echo ',inputSchema:{type:'object'}}]};
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const httpCapability={type:'mcp',mcpServer:{transport:'streamableHttp',url:'http://127.0.0.1:'+server.address().port}};
try{
 failClient=true;
 const loadFailure=await api.probeMcpCapability(httpCapability,options);
 assert.equal(loadFailure.connectionStatus,'disconnected');
 assert.match(loadFailure.error,/fixture SDK import unavailable/);
 assert.equal(httpRequests,0,'SDK load failure must not start a transport');
 const connected=await api.probeMcpCapability(httpCapability,options);
 assert.deepEqual(connected,{connectionStatus:'connected',tools:[{name:'echo',description:'echo'}]});
 assert.equal(requested.includes('@modelcontextprotocol/sdk/client/stdio.js'),false,'HTTP activity must not load stdio');
 const successfulRequests=requested.length;
 assert.equal((await api.probeMcpCapability(httpCapability,options)).connectionStatus,'connected');
 assert.equal(requested.length,successfulRequests,'successful imports must be cached');
 const timeout=await api.probeMcpCapability({...httpCapability,mcpServer:{...httpCapability.mcpServer,headers:{'x-fixture-mode':'hang'}}},{...options,timeoutMs:100});
 assert.equal(timeout.connectionStatus,'disconnected');
 assert.match(timeout.error,/timeout|timed out/i);
}finally{
 server.closeAllConnections();
 await new Promise(resolve=>server.close(resolve));
}
const childSource=[
 "const lines=require('node:readline').createInterface({input:process.stdin});",
 "const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');",
 "lines.on('line',line=>{const m=JSON.parse(line);",
 "if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});",
 "if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}},{name:'hang',inputSchema:{type:'object'}},{name:'invalid',inputSchema:{type:'object'}},{name:'disconnect',inputSchema:{type:'object'}}]}});",
 "if(m.method==='tools/call'&&m.params.name==='echo')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(m.params.arguments)}]}});",
 "if(m.method==='tools/call'&&m.params.name==='invalid')send({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'fixture invalid arguments'}});",
 "if(m.method==='tools/call'&&m.params.name==='disconnect')process.exit(0);",
 "});"
].join('\n');
const spec={pluginInstanceId:'fixture',pluginId:'fixture',contributionId:'mcp',command:process.execPath,args:['--eval',childSource],cwd:process.cwd(),env:{}};
failTypes=true;
await assert.rejects(runtime.start(spec),/fixture SDK types import unavailable/);
const handle=await runtime.start(spec);
try{
 const {McpError,ErrorCode}=await import('@modelcontextprotocol/sdk/types.js');
 assert.equal((await handle.callTool('echo',{value:42})).content[0].text,'{"value":42}');
 await assert.rejects(handle.callTool('invalid',{}),error=>error instanceof McpError&&error.code===ErrorCode.InvalidParams);
 runtimeOptions.callTimeoutMs=100;
 try{await assert.rejects(handle.callTool('hang',{}),/timed out/);}
 finally{runtimeOptions.callTimeoutMs=5000;}
 assert.equal((await handle.callTool('echo',{afterTimeout:true})).content[0].text,'{"afterTimeout":true}');
 await assert.rejects(handle.callTool('disconnect',{}),error=>error instanceof McpError&&error.code===ErrorCode.ConnectionClosed);
}finally{await handle.close();}
const restarted=await runtime.start(spec);
try{assert.equal((await restarted.callTool('echo',{restart:true})).content[0].text,'{"restart":true}');}
finally{await restarted.close();}
const probe=await api.probeMcpCapability({type:'mcp',mcpServer:{command:process.execPath,args:['--eval',childSource]}},options);
assert.equal(probe.connectionStatus,'connected');
assert.equal(probe.tools.length,4);
assert.ok(requested.includes('@modelcontextprotocol/sdk/client/stdio.js'));
console.log('official lazy MCP consumers passed');
`;
