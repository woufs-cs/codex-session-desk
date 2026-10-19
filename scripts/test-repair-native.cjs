// Synthetic isolated Codex home only. Does not run a turn or close the desktop.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const core=require('../core.cjs'),rpc=require('../codex-rpc.cjs'),sync=require('../project-sync.cjs');
(async()=>{
 const cli=await require('../codex-cli.cjs').detect();assert.ok(cli);
 const home=path.resolve('test-data','native-repair-'+core.uuid()),expected=path.join(home,'project'),old=path.join(home,'old-project'),id=core.uuid();
 await fs.mkdir(path.join(home,'sessions'),{recursive:true});await fs.mkdir(expected);await fs.mkdir(old);
 const timestamp=new Date().toISOString(),file=path.join(home,'sessions',`rollout-${timestamp.slice(0,19).replace(/:/g,'-')}-${id}.jsonl`);
 const raw=[{type:'session_meta',timestamp,payload:{id,timestamp,cwd:old,originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai'}},{type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic repair check. No model request.'}]}}].map(JSON.stringify).join('\n')+'\n';await fs.writeFile(file,raw);
 await rpc.withClient(cli.path,home,async request=>{await request('thread/resume',{threadId:id,cwd:old,excludeTurns:true});assert.equal((await request('thread/read',{threadId:id,includeTurns:false})).thread.cwd,old);});
 const remapped=file+'.mapped';await require('../session-io.cjs').mapFile(file,remapped,expected);await fs.rename(remapped,file);
 const report={home,results:[{id,status:'imported'}],sessionFiles:{[id]:file},expectedDirectories:{[id]:expected},projectSettings:{mode:'cli'},verification:{results:[{id,cwd:old,pathMatches:false}]}};
 const result=await sync.repair(cli.path,report,id);assert.equal(result.complete,true,JSON.stringify(result));
 await rpc.withClient(cli.path,home,async request=>assert.equal((await request('thread/read',{threadId:id,includeTurns:false})).thread.cwd,expected));
 await fs.writeFile(path.join(home,'result.json'),JSON.stringify(result,null,2));console.log('NATIVE_REPAIR_PASS',home);
})().catch(e=>{console.error(e);process.exitCode=1;});
