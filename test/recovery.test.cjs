const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const c=require('../core.cjs'),r=require('../recovery.cjs');
const raw=()=>JSON.stringify({type:'session_meta',payload:{id:'session',cwd:'D:/A'}})+'\n';
const message=text=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-apply-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const cache=path.join(root,'cache'),home=path.join(root,'home');await fs.mkdir(cache);return {root,cache,home};}
async function row(cache,text){const hash=c.hash(text);await fs.writeFile(path.join(cache,hash+'.jsonl'),text);return {id:'session',hash};}
test('new -> grow -> ahead, exact backup, remapping and idempotence',async t=>{
  const {root,cache,home}=await setup(t),base=raw()+message('first');
  await r.apply([await row(cache,base)],cache,home,root);
  const prior=(await c.scan(home)).sessions[0];
  const result=await r.apply([await row(cache,base+message('second'))],cache,home,root);
  assert.equal(result.results[0].status,'updated');
  assert.equal(await fs.readFile(path.join(path.dirname(result.reportPath),'0.jsonl'),'utf8'),prior.raw);
  assert.equal((await c.scan(home)).sessions[0].messages.length,2);
  assert.equal((await r.apply([await row(cache,base)],cache,home,root)).results[0].status,'ahead');
  assert.equal((await r.apply([await row(cache,base+message('second'))],cache,home,root)).results[0].status,'identical');
});
test('divergent histories remain independent, repeats do not duplicate branches',async t=>{
  const {root,cache,home}=await setup(t);await r.apply([await row(cache,raw()+message('local'))],cache,home,root);
  const remote=await row(cache,raw()+message('remote'));
  assert.equal((await r.apply([remote],cache,home,root,{conflicts:'skip'})).results[0].status,'conflict');
  const result=await r.apply([remote],cache,home,root);assert.equal(result.results[0].status,'branched');
  assert.equal((await c.scan(home)).sessions.length,2);
  assert.equal((await r.apply([remote],cache,home,root)).results[0].status,'branch-already-present');
});
test('corrupt later object aborts entire preparation before any session write',async t=>{
  const {root,cache,home}=await setup(t),good=await row(cache,raw());
  await assert.rejects(r.apply([good,{id:'other',hash:'a'.repeat(64)}],cache,home,root));
  assert.equal((await c.scan(home)).sessions.length,0);
});
test('existing lock blocks concurrent restoration',async t=>{
  const {root,cache,home}=await setup(t);await fs.mkdir(home);await fs.writeFile(path.join(home,'.session-desk-restore.lock'),'');
  await assert.rejects(r.apply([await row(cache,raw())],cache,home,root),/锁/);
});
test('failed later write rolls back earlier update exactly',async t=>{
  const {root,cache,home}=await setup(t),base=raw()+message('first');
  await r.apply([await row(cache,base)],cache,home,root);
  const original=(await c.scan(home)).sessions[0];
  // Build a distinct valid session rather than replacing the record type.
  const second=JSON.stringify({type:'session_meta',payload:{id:'other',cwd:root}})+'\n';
  const digest=c.hash(second);await fs.writeFile(path.join(cache,digest+'.jsonl'),second);
  const link=fs.link;fs.link=async()=>{throw Error('simulated disk failure');};
  try{await assert.rejects(r.apply([await row(cache,base+message('second')),{id:'other',hash:digest}],cache,home,root),/simulated/);}finally{fs.link=link;}
  assert.equal(await fs.readFile(original.file,'utf8'),original.raw);assert.equal((await c.scan(home)).sessions.length,1);
});
test('thread settings and filesystem permissions follow mapped project without changing message text',()=>{
  const settings={cwd:'D:/A',runtime_workspace_roots:['D:/A'],permission_profile:{file_system:{entries:[{path:{path:'D:/A/.git'}}]}}};
  const source=raw()+JSON.stringify({type:'event_msg',payload:{thread_settings:settings}})+'\n'+message('D:/A stays in text');
  const target=r.mapped(source,'E:/B');const records=target.trim().split('\n').map(JSON.parse);
  assert.equal(records[1].payload.thread_settings.cwd,'E:/B');
  assert.equal(records[1].payload.thread_settings.permission_profile.file_system.entries[0].path.path,'E:/B/.git');
  assert.deepEqual(c.parse(source).messages,c.parse(target).messages);assert.equal(c.relation(source,target),'identical');
});

test('secondary root permissions map consistently without creating false history conflicts',()=>{
  const source=raw()+JSON.stringify({type:'turn_context',payload:{cwd:'D:/A',runtime_workspace_roots:['D:/A','D:/data'],permission_profile:{file_system:{entries:[{path:{path:'D:/data/private'}}]}}}})+'\n';
  const mappings=[{sourcePath:'D:/A',targetPath:'E:/B'},{sourcePath:'D:/data',targetPath:'E:/shared'}];
  const target=r.mapped(source,'E:/B',null,mappings),record=JSON.parse(target.trim().split('\n')[1]);
  assert.deepEqual(record.payload.runtime_workspace_roots,['E:/B','E:\\shared']);
  assert.equal(record.payload.permission_profile.file_system.entries[0].path.path,'E:\\shared\\private');
  assert.equal(c.relation(target,source,mappings),'identical');
});

test('per-thread workdir preserves subdirectories and source project IDs are not imported',async t=>{
  const {root,cache,home}=await setup(t),cwd=path.join(root,'scripts'),text=raw().replace('"cwd":"D:/A"','"cwd":"D:/A","project_id":"source-machine-project"')+message('one');
  const rowValue={...await row(cache,text),targetCwd:cwd};await r.apply([rowValue],cache,home,root);
  const local=(await c.scan(home)).sessions[0];assert.equal(local.cwd,cwd);assert.equal(JSON.parse(local.raw.split('\n')[0]).payload.project_id,undefined);
  assert.equal((await r.apply([rowValue],cache,home,root)).results[0].status,'identical');
  await assert.rejects(r.apply([{...rowValue,targetCwd:root}],cache,home,root),/目录与映射不同/);
});

test('per-row conflicts require a decision; skip and branch remain independent',async t=>{
 const {root,cache,home}=await setup(t);await r.apply([await row(cache,raw()+message('local'))],cache,home,root);const remote=await row(cache,raw()+message('remote'));
 await assert.rejects(r.apply([remote],cache,home,root,{perRow:true}),/逐条选择/);
 const worker=require('../sync-worker.cjs'),events=[];const result=await worker.run('receive',{rows:[{...remote,conflictPolicy:'skip'}],cache,home,cwd:root,options:{perRow:true}},e=>events.push(e));assert.equal(result.results[0].status,'conflict');assert.ok(events.some(e=>e.stage==='扫描本机对话'));assert.equal((await c.scan(home)).sessions.length,1);
 const branched=await worker.run('receive',{rows:[{...remote,conflictPolicy:'keep-both'}],cache,home,cwd:root,options:{perRow:true}},e=>events.push(e));assert.equal(branched.results[0].status,'branched');assert.ok(events.some(e=>e.stage==='写入对话'));
 const scanned=await worker.run('scan',{home});assert.equal(scanned.sessions.length,2);assert.equal(scanned.sessions[0].raw,undefined);assert.equal(scanned.sessions[0].messages.length,0);
});
