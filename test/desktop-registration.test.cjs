const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {prepare,register}=require('../desktop-registration.cjs');
const state=()=>({'local-projects':{},'project-order':[]});const project={id:'native-project',name:'Paper',roots:[{path:'/Users/test/paper'}]};
test('desktop registration reuses native ID, is idempotent and includes subsequent conversations',()=>{
 const a=prepare(state(),'/Users/test/.codex',project,['t1']);assert.equal(a.legacyId,project.id);assert.equal(a.state['app-server-project-id-by-legacy-project-id-by-host']['local:/Users/test/.codex'][project.id],project.id);
 const b=prepare(a.state,'/Users/test/.codex',project,['t1','t2']);assert.equal(Object.keys(b.state['local-projects']).length,1);assert.equal(b.state['thread-project-assignments'].t2.projectId,project.id);assert.deepEqual(prepare(b.state,'/Users/test/.codex',project,['t1','t2']).state,b.state);
});
test('same name or directory never merges another project; identity mapping wins',()=>{
 const s=state();s['local-projects'].other={id:'other',name:'Paper',rootPaths:['/Users/test/paper']};const a=prepare(s,'/home',project,['t']);assert.equal(Object.keys(a.state['local-projects']).length,2);
 const migrated=state();migrated['local-projects'].old={id:'old',name:'Original',rootPaths:['/Users/test/paper']};migrated['app-server-project-id-by-legacy-project-id-by-host']={'local:/home':{old:project.id}};
 const b=prepare(migrated,'/home',project,['t']);assert.equal(b.legacyId,'old');assert.equal(Object.keys(b.state['local-projects']).length,1);
});
test('unknown schema, foreign host and conflicting assignments stop before writing',()=>{
 assert.throws(()=>prepare({'local-projects':[]},'/home',project,[]),/格式/);
 const s=state();s['thread-project-assignments']={t:{projectKind:'local',projectId:'other'}};assert.throws(()=>prepare(s,'/home',project,['t']),/其他桌面/);
 delete s['thread-project-assignments'];s['thread-project-membership-host-ids']={t:'remote'};assert.throws(()=>prepare(s,'/home',project,['t']),/其他主机/);
});
test('registration checks shutdown, preserves unrelated state and backs up only on change',async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'desk-reg-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const file=path.join(home,'.codex-global-state.json'),original=JSON.stringify({...state(),unrelated:{keep:1}});await fs.writeFile(file,original);
 await assert.rejects(register(home,project,['t'],{requireStopped:async()=>{throw Error('running')}}),/running/);assert.equal(await fs.readFile(file,'utf8'),original);
 let checks=0;const services={requireStopped:async()=>{checks++}};const result=await register(home,project,['t'],services);assert.equal(checks,2);assert.equal(await fs.readFile(result.backup,'utf8'),original);assert.deepEqual(JSON.parse(await fs.readFile(file)).unrelated,{keep:1});assert.equal((await register(home,project,['t'],services)).changed,false);
});
test('concurrent desktop state modification stops registration without overwriting',async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'desk-race-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const file=path.join(home,'.codex-global-state.json');await fs.writeFile(file,JSON.stringify(state()));let checks=0;const newer=JSON.stringify({...state(),updated:true});
 await assert.rejects(register(home,project,['t'],{requireStopped:async()=>{if(++checks===2)await fs.writeFile(file,newer)}}),/变化/);assert.equal(await fs.readFile(file,'utf8'),newer);
});
test('macOS trusted system aliases are allowed, arbitrary symbolic links remain rejected', {skip:process.platform!=='darwin'},async t=>{
 const safe=require('../recovery.cjs').safePath;await safe('/tmp');await safe('/var');const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'desk-link-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.symlink(root,path.join(root,'alias'));await assert.rejects(safe(path.join(root,'alias','file')),/链接/);
});

test('finish distinguishes native success from sidebar visibility and registers existing native identity',async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'desk-finish-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.mkdir(path.join(home,'sessions'));
 const cwd=path.join(home,'project'),file=path.join(home,'sessions','t.jsonl');await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'t',cwd}})+'\n');await fs.writeFile(path.join(home,'.codex-global-state.json'),JSON.stringify(state()));
 const rpc=require('../codex-rpc.cjs'),life=require('../codex-lifecycle.cjs');const original=rpc.withClient,stopped=life.requireStopped;let created=0;
 rpc.withClient=async(_exe,_home,fn)=>fn(async(method,args)=>{const p={id:'existing',name:'Paper',roots:[{path:cwd}]},thread={id:'t',cwd,projectId:'existing'};if(method==='project/create'){created++;return {project:p}}if(method==='project/read')return {project:p};if(method==='project/list')return {data:[p]};if(method==='thread/list')return {data:args.archived?[]:[thread]};if(method==='thread/read')return {thread};if(method==='thread/metadata/update')return {};throw Error(method)});life.requireStopped=async()=>{};
 try{const result=await require('../project-sync.cjs').finish('fake',{home,sessionFiles:{t:file},results:[{id:'t',status:'identical'}],projectSettings:{mode:'desktop',projectId:'existing',roots:[cwd]}},async()=>{});assert.equal(created,0);assert.equal(result.nativeComplete,true);assert.equal(result.desktopRegistration.registered,true);assert.equal(result.complete,false);assert.equal(result.desktopVerified,false);}finally{rpc.withClient=original;life.requireStopped=stopped;}
});
