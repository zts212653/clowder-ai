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
const entries = {
  ImageExportBrowserSession: 'services/image-export-browser-session.ts',
  runContainedMaterializer: 'domains/plugin/content-materializer-runtime/browser-runner.ts',
  openCurrentBrowserPage: 'domains/concierge/action/jev/OwnerCurrentPageBrowser.ts',
  createOwnerCdpConnector: 'domains/concierge/action/jev/OwnerCdpConnector.ts',
  maybeStartOwnerLocalNoteLab: 'domains/concierge/live/host/owner-local-note-lab.ts',
  DefaultFeishuQrBindClient: 'infrastructure/connectors/FeishuQrBindClient.ts',
  OfficialPluginAuthService: 'domains/plugin/official-plugin-auth.ts',
  SignalEmailService: 'domains/signals/services/email-service.ts',
  createRetryableLoader: 'utils/retryable-loader.ts',
};

test('optional API services import no heavy clients until use, cache success and retry failures', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'api-lazy-heavy-'));
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(fixture, '.git'), 'gitdir: fixture');
    const scripts = path.join(fixture, 'scripts', 'f317-page-action');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(
      path.join(scripts, 'serve.mjs'),
      "export async function startFixtureServer(){return {url:'http://127.0.0.1:5327/',server:{listening:true,address(){return {address:'127.0.0.1',port:5327};},close(done){globalThis.heavyFixture.serverCloses++;done();}}};}",
    );
    fs.writeFileSync(
      path.join(scripts, 'browser-binary.mjs'),
      'export async function loadChromium(){return {executablePath:()=>process.execPath};}',
    );
    const entry = Object.entries(entries)
      .map(([name, file]) => `export {${name}} from ${JSON.stringify(path.join(root, 'src', file))};`)
      .join('\n');
    await build({
      stdin: { contents: entry, resolveDir: root },
      outfile: path.join(fixture, 'services.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['puppeteer-core', 'qrcode', 'nodemailer'],
      plugins: [
        {
          name: 'silent-fixture-logger',
          setup(builder) {
            builder.onResolve({ filter: /infrastructure\/logger\.js$/ }, () => ({
              path: 'logger',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: 'export const createModuleLogger=()=>({info(){},warn(){},error(){},debug(){}});',
            }));
            builder.onResolve({ filter: /\/process-budget\.js$/ }, () => ({ path: 'monitor', namespace: 'monitor' }));
            builder.onLoad({ filter: /.*/, namespace: 'monitor' }, () => ({
              contents:
                'export async function monitorPrivateBrowser(){return {stop(){},kill(){},assertDisposed(){},metrics(){return {fixture:true};}};}',
            }));
          },
        },
      ],
    });
    fs.writeFileSync(path.join(fixture, 'run.mjs'), consumer);
    const output = execFileSync(process.execPath, [path.join(fixture, 'run.mjs')], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, CHROME_EXECUTABLE_PATH: process.execPath, LAZY_LAB_ROOT: fixture },
    });
    assert.match(output, /lazy consumers passed/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

const consumer = `
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const state=globalThis.heavyFixture={loads:{},launches:0,connects:0,disconnects:0,serverCloses:0,creates:0,sends:0,qr:0,failImport:true,failTransport:true};
const modules={
 'puppeteer-core': "import {EventEmitter} from 'node:events';globalThis.heavyFixture.loads.browser=1;const page={fixture:true,url:()=> 'http://127.0.0.1:5327/',target:()=>({_targetId:'chosen'}),async setCacheEnabled(){},async setBypassServiceWorker(){},async setRequestInterception(){},on(){},async goto(){},async evaluate(){return '{}';}};class Browser extends EventEmitter{constructor(materializer){super();this.materializer=materializer;}isConnected(){return true;}process(){return this.materializer?{pid:42,spawnargs:[]}:null;}async newPage(){return page;}async pages(){return [page];}disconnect(){globalThis.heavyFixture.disconnects++;}async close(){}};export default {async launch(options){globalThis.heavyFixture.launches++;return new Browser(Boolean(options.userDataDir));},async connect(){globalThis.heavyFixture.connects++;return new Browser(false);}};",
 qrcode: "globalThis.heavyFixture.loads.qr=1;export default {async toDataURL(){globalThis.heavyFixture.qr++;return 'data:fixture';}};",
 nodemailer: "globalThis.heavyFixture.loads.mail=1;export default {createTransport(){const s=globalThis.heavyFixture;s.creates++;if(s.failTransport){s.failTransport=false;throw Error('transport failed');}return {async sendMail(){s.sends++;return {messageId:'fixture'};}};}};",
};
registerHooks({resolve(specifier,context,next){
 if(!(specifier in modules))return next(specifier,context);
 if(specifier==='puppeteer-core'&&state.failImport){state.failImport=false;throw Error('import failed');}
 return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
}});
const api=await import('./services.mjs');
assert.deepEqual(state.loads,{});
let attempts=0;
let release;
const deferred=new Promise(resolve=>{release=resolve;});
const load=api.createRetryableLoader(()=>{attempts++;return deferred;});
const first=load();
assert.equal(load(),first);
await Promise.resolve();
assert.equal(attempts,1);
release('ready');
assert.equal(await first,'ready');
assert.equal(load(),first);
let retryAttempts=0;
const retry=api.createRetryableLoader(()=>{if(++retryAttempts===1)throw Error('sync failed');return Promise.resolve('retried');});
await assert.rejects(retry(),/sync failed/);
assert.equal(await retry(),'retried');
assert.equal(retryAttempts,2);
assert.equal(await api.maybeStartOwnerLocalNoteLab({enabled:false}),null);
new api.OfficialPluginAuthService({packages:{}});
const digest={subject:'fixture',html:'fixture',text:'fixture'};
const config=enabled=>({notifications:{email:{enabled,smtp:{host:'unused',port:1,secure:false},from:'fixture',to:'fixture'}}});
assert.equal((await new api.SignalEmailService({config:config(false)}).sendDailyDigest(digest)).status,'skipped');
assert.deepEqual(state.loads,{});
const session=new api.ImageExportBrowserSession();
await assert.rejects(session.openPage(),/import failed/);
assert.equal((await session.openPage()).fixture,true);
assert.equal((await session.openPage()).fixture,true);
assert.equal(state.launches,1);
await session.close();
globalThis.fetch=async input=>new Response(JSON.stringify(String(input).endsWith('/json/list')?[{id:'chosen',type:'page',url:'http://127.0.0.1:5327/',title:'Fixture'}]:{webSocketDebuggerUrl:'ws://127.0.0.1:5328/devtools/browser/fixture'}));
const signal=new AbortController().signal;
const selected={id:'chosen',url:'http://127.0.0.1:5327/',title:'Fixture'};
const current={mode:'owner-selected',profileId:'fixture',browserURL:'http://127.0.0.1:5328/',allowJevProjection:true};
const selectedHandle=await api.openCurrentBrowserPage(current,selected,signal);
assert.equal(selectedHandle.page.fixture,true);
await selectedHandle.close();
const configured={profileId:'fixture',pageUrl:selected.url,browserURL:current.browserURL,allowJevProjection:true,targets:[{id:'fill',selector:'#note',operation:'fill',expectedReadbackTemplate:'{value}'}],readback:{selector:'#note',kind:'value'}};
const profile={profileId:'fixture',url:selected.url,spec:{targets:[{id:'fill',selector:'#note',operation:'fill'}],readback:configured.readback}};
const configuredHandle=await api.createOwnerCdpConnector(configured).open(profile,signal);
assert.equal(configuredHandle.page.fixture,true);
await configuredHandle.close();
assert.equal(state.connects,2);
assert.equal(state.disconnects,2);
const lab=await api.maybeStartOwnerLocalNoteLab({enabled:true,projectRoot:process.env.LAZY_LAB_ROOT,apiPort:5329,apiHost:'127.0.0.1',memoryStore:true,nodeEnv:'test'});
assert.equal(lab.url,selected.url);
await lab.close();
assert.equal(state.serverCloses,1);
const nativePlatform=process.platform;
try{
 Object.defineProperty(process,'platform',{value:'linux'});
 const result=await api.runContainedMaterializer({module:Buffer.from('fixture'),requestJson:'{}',signal});
 assert.equal(result.json,'{}');
 assert.equal(result.metrics.disposed,true);
}finally{Object.defineProperty(process,'platform',{value:nativePlatform});}
assert.equal(state.launches,3);
const mail=new api.SignalEmailService({config:config(true)});
assert.equal((await mail.sendDailyDigest(digest)).status,'error');
assert.equal((await mail.sendDailyDigest(digest)).status,'sent');
assert.equal((await mail.sendDailyDigest(digest)).status,'sent');
assert.equal(state.creates,2);
assert.equal(state.sends,2);
let injected=0;
const injectedMail=new api.SignalEmailService({config:config(true),createTransporter(){injected++;return {async sendMail(){return {messageId:'injected'};}};}});
assert.equal((await injectedMail.sendDailyDigest(digest)).messageId,'injected');
assert.equal(injected,1);
const qr=new api.DefaultFeishuQrBindClient(async()=>({ok:true,json:async()=>({supported_auth_methods:['client_secret'],verification_uri_complete:'https://accounts.feishu.cn/fixture',device_code:'fixture'})}));
assert.equal((await qr.create()).qrUrl,'data:fixture');
assert.equal((await qr.create()).qrUrl,'data:fixture');
assert.equal(state.qr,2);
const official=new api.OfficialPluginAuthService({
 packages:{async resolveInstalledPackage(){return {rootDir:process.env.LAZY_LAB_ROOT,async verifyIntegrity(){},async release(){}};}},
 async run(){return {stdout:JSON.stringify({device_code:'fixture-only',verification_url:'https://accounts.feishu.cn/fixture'}),stderr:''};},
});
const ownerAuth={kind:'lark-cli-device',runnerPath:'scripts/f317-page-action/browser-binary.mjs',domains:['note']};
const started=await official.start({entry:{ownerAuth},instance:{pluginInstanceId:'fixture',packageDigest:'fixture'}});
assert.equal(started.qrDataUrl,'data:fixture');
await official.shutdown();
assert.equal(state.qr,3);
assert.deepEqual(state.loads,{browser:1,mail:1,qr:1});
console.log('lazy consumers passed');
`;
