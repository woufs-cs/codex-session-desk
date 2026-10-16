const {test}=require('node:test'),assert=require('node:assert/strict');
const {merge}=require('../desktop-membership.cjs');
const state={
 'app-server-project-id-by-legacy-project-id-by-host':{'local:C:\\Users\\me\\.codex':{old:'p'}},
 'thread-project-assignments':{a:{projectKind:'local',projectId:'old'},b:{projectKind:'local',projectId:'old'}}
};
test('desktop explicit legacy assignments resolve through host-scoped native migration IDs',()=>{
 const result=merge({projects:[{id:'p'}],threads:[{id:'a',projectId:null}]},state,'c:/users/me/.codex',[{id:'b',cwd:'D:/work',title:'B'}]);
 assert.equal(result.threads.length,2);assert.ok(result.threads.every(t=>t.projectId==='p'&&t.membershipSource==='desktop-legacy'));
 assert.equal(result.threads[1].title,'B');
});
test('native membership wins; another home and cwd alone cannot assign threads',()=>{
 const inventory={projects:[{id:'p'},{id:'q'}],threads:[{id:'a',projectId:'q'},{id:'unassigned',projectId:null,cwd:'D:/work'}]};
 const result=merge(inventory,state,'C:/Users/me/.codex');assert.equal(result.threads[0].projectId,'q');assert.equal(result.threads[1].projectId,null);
 assert.equal(merge({projects:[{id:'p'}],threads:[{id:'a',projectId:null}]},state,'C:/other').threads[0].projectId,null);
});
test('deleted targets and missing histories produce a diagnostic, never invented members',()=>{
 const result=merge({projects:[],threads:[]},state,'C:/Users/me/.codex');assert.equal(result.threads.length,0);assert.equal(result.warnings.length,1);
});
test('unique exact directory fallback handles Windows extended paths without writing native membership',()=>{
 const result=merge({projects:[{id:'p',roots:[{path:'D:\\project\\esc'}]}],threads:[{id:'a',projectId:null,cwd:'\\\\?\\D:\\Project\\esc',source:'vscode'},{id:'child',cwd:'D:/project/esc/sub'}]}, {}, 'C:/Codex');
 assert.equal(result.threads[0].projectId,'p');assert.equal(result.threads[0].nativeProjectId,null);assert.equal(result.threads[0].membershipSource,'desktop-directory');assert.equal(result.threads[1].projectId,undefined);
});
test('explicit projectless, foreign host, explicit foreign assignment, ambiguity and subagents are not absorbed',()=>{
 const inventory={projects:[{id:'p',roots:[{path:'D:/esc'}]}],threads:['loose','foreign','assigned','normal','agent'].map(id=>({id,cwd:'D:/esc',projectId:null,source:id==='agent'?{subAgent:{other:'guardian'}}:'vscode'}))};
 const state={'projectless-thread-ids':['loose'],'thread-project-membership-host-ids':{foreign:'remote-host'},'thread-project-assignments':{assigned:{projectKind:'local',projectId:'missing'}}};
 const result=merge(inventory,state,'C:/Codex');assert.equal(result.threads.length,4);assert.deepEqual(result.threads.filter(t=>t.projectId).map(t=>t.id),['normal']);
 const ambiguous=merge({...inventory,projects:[...inventory.projects,{id:'q',roots:[{path:'D:/esc'}]}]},state,'C:/Codex');assert.equal(ambiguous.threads.filter(t=>t.projectId).length,0);assert.ok(ambiguous.warnings.some(w=>w.includes('多个项目')));
});
test('thread listing preserves archive query status when individual records omit archived',async()=>{
 const {listThreads}=require('../codex-rpc.cjs');const threads=await listThreads(async(_method,p)=>({data:[{id:p.archived?'old':'current',cwd:'D:/esc'}],nextCursor:null}));
 assert.equal(threads[0].archived,false);assert.equal(threads[1].archived,true);
});
test('directory display inference does not become a hard restore conflict; native membership still does',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const home=await fs.mkdtemp(path.join(os.tmpdir(),'desk-membership-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 let native=null;const request=async(method,p)=>({data:method==='project/list'?[{id:'p',roots:[{path:'D:/esc'}]}]:p.archived?[]:[{id:'t',cwd:'D:/esc',projectId:native}],nextCursor:null});
 const {preflight}=require('../project-sync.cjs');await preflight(request,{home,mode:'desktop',projectId:null,roots:['D:/esc']},[{id:'t'}]);native='p';await assert.rejects(preflight(request,{home,mode:'desktop',projectId:null,roots:['D:/esc']},[{id:'t'}]),/归属冲突/);
});
