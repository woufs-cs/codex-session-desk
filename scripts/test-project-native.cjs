// Fully synthetic homes and rollouts: no real account, conversation or model turn.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const c=require('../core.cjs'),m=require('../project-model.cjs'),r=require('../recovery.cjs'),rpc=require('../codex-rpc.cjs'),sync=require('../project-sync.cjs');
(async()=>{
  const found=await require('../codex-cli.cjs').detect();assert.ok(found,'Codex CLI required');
  const root=path.resolve('test-data','native-project-'+c.uuid()),a=path.join(root,'machine-a'),b=path.join(root,'machine-b'),cwdA=path.join(a,'paper'),cwdB=path.join(b,'paper'),cache=path.join(root,'cache');
  await fs.mkdir(cwdA,{recursive:true});await fs.mkdir(path.join(cwdB,'scripts'),{recursive:true});
  const id=c.uuid(),timestamp=new Date().toISOString();
  const raw=[{type:'session_meta',timestamp,payload:{id,timestamp,cwd:path.join(cwdA,'scripts'),originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai'}},{type:'event_msg',timestamp,payload:{type:'user_message',message:'Synthetic test only.',images:[],local_images:[],text_elements:[]}},{type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic test only. No model request.'}]}},{type:'response_item',timestamp,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic response.'}]}}].map(JSON.stringify).join('\n')+'\n';
  const session=c.parse(raw),definition=m.define('Paper',cwdA,[],[session]),store=new c.Store({type:'local',directory:path.join(root,'cloud')});
  session.nativeName='同步后的自定义标题';
  const commit=await c.publishProject(store,[session],'shared','Paper','machineA',undefined,undefined,definition);
  const catalog=await c.discoverProjects(store);assert.equal(catalog[0].definition.name,'Paper');
  const home=path.join(b,'codex-home');await fs.mkdir(home,{recursive:true});
  const rows=m.preview(await c.download(c.projectStore(store,commit),commit,[],cache),definition,{'root-0':cwdB});
  assert.equal(rows[0].remoteName,session.nativeName);
  const report=await r.apply(rows,cache,home,cwdB);report.expectedNames={[id]:rows[0].remoteName};report.projectSettings={mode:'desktop',name:'Paper',roots:[cwdB],syncId:'shared',key:'test-'+c.uuid()};
  const result=await sync.finish(found.path,report,async projectId=>report.projectSettings.projectId=projectId);assert.equal(result.complete,true,JSON.stringify(result));
  const again=await sync.finish(found.path,report);assert.equal(again.complete,true,JSON.stringify(again));
  const inventory=await rpc.inventory(found.path,home);assert.equal(inventory.threads.find(t=>t.id===id).nativeName,session.nativeName);
  await rpc.withClient(found.path,home,async request=>{const props=require('../desktop-properties.cjs');await props.rename(request,{kind:'thread',id,value:'本机修改标题',expected:session.nativeName});await props.rename(request,{kind:'project',id:report.projectSettings.projectId,value:'本机项目名',expected:'Paper'});const target=(await request('project/create',{name:'Temporary target',roots:[{path:cwdB}],idempotencyKey:'move-'+id})).project;await props.move(request,{id,targetProjectId:target.id,expectedNativeProjectId:report.projectSettings.projectId});await props.move(request,{id,targetProjectId:report.projectSettings.projectId,expectedNativeProjectId:target.id});});assert.equal(inventory.projects.length,1);assert.equal(inventory.threads.find(t=>t.id===id).projectId,report.projectSettings.projectId);
  const cli=await sync.finish(found.path,{...report,projectSettings:{...report.projectSettings,mode:'cli'}});assert.equal(cli.complete,true);assert.equal(cli.results[0].projectId,report.projectSettings.projectId);
  const cliHome=path.join(root,'cli-only-home');const cliReport=await r.apply(rows,cache,cliHome,cwdB);cliReport.projectSettings={...report.projectSettings,mode:'cli',projectId:null};
  const cliOnly=await sync.finish(found.path,cliReport);assert.equal(cliOnly.complete,true,JSON.stringify(cliOnly));assert.equal((await rpc.inventory(found.path,cliHome)).projects.length,0);
  const stored=(await c.scan(home)).sessions[0];assert.equal(c.relation(raw,stored.raw),'identical');
  // A later A-side message must grow the existing B thread, keeping its project.
  const extension=raw+JSON.stringify({type:'event_msg',timestamp,payload:{type:'user_message',message:'Second synthetic message',images:[],local_images:[],text_elements:[]}})+'\n';
  const newer=await c.publishProject(store,[c.parse(extension)],'shared','Paper','machineA',undefined,undefined,definition);
  const nextRows=m.preview(await c.download(c.projectStore(store,newer),newer,(await c.scan(home)).sessions,cache),definition,{'root-0':cwdB});assert.equal(nextRows[0].status,'grow');
  const grown=await r.apply(nextRows,cache,home,cwdB);grown.projectSettings=report.projectSettings;assert.equal((await sync.finish(found.path,grown)).complete,true);assert.equal((await rpc.inventory(found.path,home)).projects.length,2);
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify({result,again,cli},null,2));console.log('NATIVE_PROJECT_PASS',root);
})().catch(e=>{console.error(e);process.exitCode=1;});
