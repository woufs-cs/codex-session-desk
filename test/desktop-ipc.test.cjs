const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{createRequire}=require('node:module');
const core=require('../core.cjs'),realRequire=createRequire(path.resolve(__dirname,'../main.cjs'));
test('actual IPC keeps same-root projects separate through publish, new-target receive, promotion, restart and republish',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-ipc-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),userData=path.join(root,'app'),cwd=path.join(root,'shared'),other=path.join(root,'target');
 for(const p of [path.join(home,'sessions'),userData,cwd,other])await fs.mkdir(p,{recursive:true});
 const projects=['p1','p2'].map(id=>({id,name:id,roots:[{path:cwd}]})),threads=['t1','t2'].map((id,i)=>({id,projectId:'p'+(i+1),cwd,title:id,nativeName:'Title '+id,membershipSource:'native'}));
 for(const th of threads){const raw=[{type:'session_meta',payload:{id:th.id,cwd}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:th.title}]}}].map(JSON.stringify).join('\n')+'\n';await fs.writeFile(path.join(home,'sessions',th.id+'.jsonl'),raw);}
 const config={type:'local',directory:path.join(root,'cloud')};
 await fs.writeFile(path.join(userData,'settings.json'),JSON.stringify({home,deviceId:'test-device',bindings:{},storage:config}));
 const request=async(method,p)=>{if(method==='project/read')return {project:projects.find(x=>x.id===p.projectId)};if(method==='thread/read')return {thread:{...threads.find(t=>t.id===p.threadId)}};if(method==='thread/metadata/update'){const t=threads.find(t=>t.id===p.threadId);t.projectId=p.projectId||null;t.nativeProjectId=t.projectId;t.membershipSource=t.projectId?'native':null;return {};}throw Error('Unexpected mock request '+method);};
 async function boot(){let ready;const handlers={};const app={disableHardwareAcceleration(){},on(){},getPath:()=>userData,getVersion:()=>'test',whenReady:()=>({then:fn=>{ready=fn();}})};
 class BrowserWindow{webContents={setWindowOpenHandler(){},on(){}};async loadFile(){}}
 const execFile=()=>{};execFile[require('node:util').promisify.custom]=async()=>({stdout:''});
 const fakeRequire=name=>name==='electron'?{app,BrowserWindow,ipcMain:{handle:(n,fn)=>handlers[n]=(...args)=>fn(null,...args)},dialog:{showMessageBox:async()=>({response:1})},safeStorage:{isEncryptionAvailable:()=>false}}:name==='./codex-cli.cjs'?{detect:async()=>({path:'fake',version:'fake'})}:name==='./codex-rpc.cjs'?{inventory:async()=>JSON.parse(JSON.stringify({projects,threads})),withClient:async(_exe,_home,fn)=>fn(request)}:name==='node:child_process'?{execFile}:name==='./project-sync.cjs'?{preflight:async()=>{},finish:async(_exe,report,onProject)=>{const id=report.projectSettings.projectId||'created';if(!projects.some(p=>p.id===id))projects.push({id,name:report.projectSettings.name,roots:[{path:other}]});await onProject(id);for(const r of report.results){if(!threads.some(t=>t.id===r.id))threads.push({id:r.id,projectId:id,cwd:report.cwd,title:'Imported',nativeName:report.expectedNames?.[r.id]||null,membershipSource:'native'});}return {complete:true,projectId:id,results:report.results.map(r=>({id:r.id,readable:true,pathMatches:true,membership:true}))};}}:realRequire(name);
 vm.runInNewContext(await fs.readFile(path.resolve(__dirname,'../main.cjs'),'utf8'),{require:fakeRequire,__dirname:path.resolve(__dirname,'..'),process,console,Buffer});await ready;return handlers;
 }
 await fs.writeFile(path.join(userData,'settings.json'),JSON.stringify({home,deviceId:'test-device',bindings:{},storage:{type:'webdav',url:'broken'}}));
 const invalidIpc=await boot();assert.match((await invalidIpc.storageOverview()).cloud,/地址无效/);await invalidIpc.saveSettings(config);
 let ipc=await boot();await assert.rejects(ipc.test({type:'webdav',url:''}),/请填写 WebDAV/);await assert.rejects(ipc.test({type:'webdav',url:'not-a-url'}),/完整的 HTTPS/);threads.push({id:'unassigned',projectId:null,cwd,title:'Unassigned'});const inventory=await ipc.desktopWorkspace();assert.ok(inventory.threads.some(t=>t.id==='unassigned'));assert.equal(inventory.unassigned,1);await ipc.moveDesktopThread({id:'unassigned',expectedProjectId:null,targetProjectId:'p1'});assert.equal(threads.find(t=>t.id==='unassigned').projectId,'p1');assert.equal((await fs.readdir(path.join(home,'session-desk-backups'))).filter(n=>n.startsWith('membership-')).length,1);await ipc.undoDesktopMembership();assert.equal(threads.find(t=>t.id==='unassigned').projectId,null);
 for(const [i,p]of projects.entries())await ipc.saveConversationProject('codex:'+p.id,{mode:'desktop',name:p.name,sourceProjectId:p.id,targetProjectId:p.id,threadIds:['t'+(i+1)]});
 const first=await ipc.publish(config,'codex:p1','',true,false),second=await ipc.publish(config,'codex:p2','',true,false);assert.notEqual(first.projectId,second.projectId);assert.equal(first.objects[0].name,'Title t1');
 let catalog=await ipc.catalog(config);assert.equal(catalog.find(c=>c.id===first.id).localRef,'codex:p1');
 assert.equal((await ipc.conversationProject('codex:p1')).cloudProjectId,first.projectId);
 const incoming=core.parse([{type:'session_meta',payload:{id:'t3',cwd}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Remote conversation'}]}}].map(JSON.stringify).join('\n')+'\n');incoming.nativeName='Remote title';
 const remote=await core.publishProject(new core.Store(config),[incoming],'remote-project','Remote','device-B',undefined,undefined,require('../project-model.cjs').define('Remote',cwd,[],[incoming]));await ipc.catalog(config);
 const bound=await ipc.desktopReceive(config,remote.id,other,{name:'Receiver',targetProjectId:null});assert.ok(bound.localRef.startsWith('cloud:'));
 await ipc.download(config,remote.id);const plan=await ipc.conversationPlan();assert.equal(plan.rows[0].targetCwd,other);assert.equal(plan.rows[0].remoteName,'Remote title');await ipc.restore();
 assert.equal((await ipc.recoveryStatus()).verification.complete,true);
 ipc=await boot();catalog=await ipc.catalog(config);assert.equal(catalog.find(c=>c.id===remote.id).localRef,'codex:created');await ipc.download(config,remote.id);assert.equal((await ipc.conversationPlan()).rows[0].status,'identical');
 const republished=await ipc.publish(config,'codex:created','',true,false);assert.equal(republished.projectId,remote.projectId);assert.equal(republished.objects[0].id,'t3');
});

