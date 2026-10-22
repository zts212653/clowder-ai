import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const configured = JSON.parse(readFileSync(resolve(root, 'packages/shared/src/deployment-profiles.json'), 'utf8'));

// Replace only the real configuration module's JSON bytes in an isolated
// process. Production selectors, compiler, segment loaders and hook installer
// all run unchanged; no consumer is mocked and no source file is edited.
const child = String.raw`
import { registerHooks } from 'node:module';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync,execFileSync } from 'node:child_process';
const root=process.cwd();
const scratch=mkdtempSync(join(tmpdir(),'edition-consumers-'));
try {
 const edition=process.env.F330_FIXTURE_EDITION;
 const canary=join(scratch,'must-not-execute');
 const policy={
  coCreatorRole:"Fixture owner "+edition+" 'quoted' {{USER_CAPSULE}} $(touch "+canary+")",
  decisionRole:'Fixture decision '+edition,
  runtimeSafetyRule:'1. **Fixture safety '+edition+'** — keep isolated storage',
  acceptanceRule:'4. **Fixture acceptance '+edition+'** — use isolated acceptance',
  modifyDataBoundary:'modify Fixture data '+edition,
  capabilityQualifier:'Fixture contextual ',
 };
 const urls=new Set(['src','dist'].map(dir=>pathToFileURL(join(root,'packages/shared',dir,'deployment-profiles.json')).href));
 registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);
  if(!urls.has(url))return loaded;
  const config=JSON.parse(String(loaded.source));
  config.activeProfile=edition;
  const selected=config.profiles[edition];
  selected.brand.displayName='Fixture product '+edition;
  selected.brand.name='Fixture ASCII '+edition;
  selected.promptPolicy=policy;
  return {...loaded,source:JSON.stringify(config)};
 }});
 const {renderSegment,loadHandoffDecisionTree,loadWorkflowTriggers}=await import('./packages/api/dist/domains/cats/services/context/prompt-template-loader.js');
 const segments={
  l1:renderSegment('L1'),
  l3:renderSegment('L3'),
  l4:renderSegment('L4'),
  s8:renderSegment('S8',{CC_NAME:'Fixture user',CC_HANDLES:'@fixture'}),
  handoff:loadHandoffDecisionTree({CC_MENTION:'@fixture'}),
  workflows:Object.values(loadWorkflowTriggers()).join('\n'),
 };
 const {compileL0}=await import('./scripts/compile-system-prompt-l0.mjs');
 const profile=join(scratch,'profile');mkdirSync(profile);
 const native=await compileL0({catId:'codex',profileDir:profile});
 const {buildAgentHookTargets}=await import('./packages/api/dist/agent-hooks/sync-targets.js');
 const hooks=buildAgentHookTargets({projectRoot:root,targetRoot:join(scratch,'installed')});
 const workspace=join(scratch,'workspace');mkdirSync(workspace);
 execFileSync('git',['init','-q','-b','main',workspace]);
 mkdirSync(join(workspace,'docs'));writeFileSync(join(workspace,'docs','fixture.md'),'fixture');
 writeFileSync(join(workspace,'fixture.png'),'fixture');
 const hookOutputs={};
 for(const hook of hooks.filter(x=>x.executable)){
  const executable=join(scratch,hook.name.replaceAll('/','-')+'.sh');
  writeFileSync(executable,hook.render());
  const result=spawnSync('bash',[executable],{cwd:workspace,input:JSON.stringify({cwd:workspace}),encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr);
  hookOutputs[hook.name]=result.stdout;
 }
 process.stdout.write('__F330_EDITION__'+JSON.stringify({edition,policy,segments,native,hookOutputs,canaryExists:existsSync(canary)})+'\n');
} finally {rmSync(scratch,{recursive:true,force:true});}
`;

for (const edition of Object.keys(configured.profiles)) {
  test(`selected ${edition} data reaches native L0, API segments and installed hooks without executing label text`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, F330_FIXTURE_EDITION: edition },
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split('\n').find((value) => value.startsWith('__F330_EDITION__'));
    assert.ok(line, result.stdout);
    const actual = JSON.parse(line.slice('__F330_EDITION__'.length));
    const { policy, segments } = actual;
    const expected = [
      ['L1', segments.l1, `Fixture product ${edition}`],
      ['L1 owner', segments.l1, policy.coCreatorRole],
      ['L3 boundary', segments.l3, policy.modifyDataBoundary],
      ['L4 storage', segments.l4, policy.runtimeSafetyRule],
      ['L4 acceptance', segments.l4, policy.acceptanceRule],
      ['S8 owner', segments.s8, policy.coCreatorRole],
      ['S8 decision', segments.s8, policy.decisionRole],
      ['handoff', segments.handoff, policy.coCreatorRole],
      ['workflows', segments.workflows, policy.coCreatorRole],
      ['native brand', actual.native, `Fixture product ${edition}`],
      ['native storage', actual.native, policy.runtimeSafetyRule],
      ['native acceptance', actual.native, policy.acceptanceRule],
      ['native owner', actual.native, policy.coCreatorRole],
      ...Object.entries(actual.hookOutputs).flatMap(([name, output]) => [
        [`${name} owner`, output, policy.coCreatorRole],
        [`${name} decision`, output, policy.decisionRole],
      ]),
    ];
    assert.deepEqual(
      expected.filter(([, output, value]) => !output.includes(value)).map(([consumer]) => consumer),
      [],
      'real consumers ignored selected configuration',
    );
    assert.equal(actual.canaryExists, false, 'a label must never execute as shell code');
  });
}
