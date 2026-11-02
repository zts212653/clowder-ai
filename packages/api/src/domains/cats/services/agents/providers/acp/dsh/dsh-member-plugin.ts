/** Runs inside the installed DSH through its public per-launch plugin seam.
 * Configuration is Host-owned and contains only the issued MCP and key digest. */
export const DSH_MEMBER_PLUGIN = `
import {createHash} from 'node:crypto';
export const name='cat-cafe-scoped-member';
export const inject=['tools','systemPrompt','agents','credentials'];
export async function apply(ctx,config){
 const hit=await ctx.credentials.resolve(config.credentialRef);
 if(!hit||createHash('sha256').update(hit.value).digest('hex')!==config.keyDigest)
  throw new Error('dsh_member_account_changed');
 const allowed=name=>name.startsWith(config.toolPrefix);
 ctx.tools.guard(call=>allowed(call.name)?undefined:'member_tool_not_allowed');
 const mcp=await import(config.mcpModule);
 ctx.on('agent/created',async({agent})=>{
  agent.ctx.tools.restrict({allow:[]});
  agent.ctx.systemPrompt.section({name:'cat-cafe-member',order:0,text:config.identity,complete:true,interpolate:false});
  agent.ctx.systemPrompt.suppressRuntimeContext();
  await agent.ctx.plugin(mcp,{transport:'stdio',serverName:config.serverName,
   command:config.server.command,args:config.server.args,env:config.server.env,
   cwd:config.server.workingDirectory,failOnStartupError:true});
 });
 ctx.provide('catCafeScopedMember',{ready:true});
}
`;
