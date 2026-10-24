const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {parse,relation,Store,publish,catalog,download,hash}=require('../core.cjs');
const {readEnv,restoreNew}=require('../core.cjs');
const {publishProject,discoverProjects,projectStore}=require('../core.cjs');
test('cloud project folders are automatic, peers discover, same names stay independent',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-library-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new Store({type:'local',directory:root}),s=parse(raw('first'));
  const a=await publishProject(store,[s],'one','same name','a');
  await publishProject(store,[s],'two','same name','b');
  const list=await discoverProjects(new Store({type:'local',directory:root}));
  assert.equal(list.length,2);assert.equal(new Set(list.map(c=>c.projectId)).size,2);
  assert(list.every(c=>c.library));
  assert.equal((await download(projectStore(store,a),a,[],path.join(root,'cache')))[0].status,'new');
  await publish(store,[s],'legacy','old project','a');
  assert.equal((await discoverProjects(store)).filter(c=>!c.library).length,1);
});
test('cwd remapping is equivalent while message changes still conflict',()=>{
  const original=raw('mapped'),mapped=original.replace('D:\\\\project\\\\example','E:\\\\other');
  assert.notEqual(original,mapped);assert.equal(relation(original,mapped),'identical');
  assert.equal(relation(original,mapped.replace('测试会话','新的对话')),'conflict');
});
test('MKCOL tolerates existing collections but propagates authentication failures',async t=>{
  const saved=global.fetch;t.after(()=>{global.fetch=saved;});const methods=[];
  global.fetch=async(_url,o)=>{methods.push(o.method);return new Response(null,{status:o.method==='MKCOL'?405:207});};
  await new Store({type:'webdav',url:'https://example.org/dav/'}).child('SessionDesk').ensure();
  assert.deepEqual(methods,['MKCOL','PROPFIND']);
  global.fetch=async()=>new Response(null,{status:401});
  await assert.rejects(new Store({type:'webdav',url:'https://example.org/dav/'}).ensure(),/401/);
});
test('env loader keeps password punctuation, rejects missing keys and ignores unrelated secrets',()=>{const result=readEnv('WEBDAV_URL=https://example.org/test/\nWEBDAV_USERNAME=user\nWEBDAV_PASSWORD="a#b=c"\nOTHER_SECRET=not-used');assert.equal(result.password,'a#b=c');assert.equal(Object.keys(result).length,4);assert.throws(()=>readEnv('WEBDAV_USERNAME=user'));});
test('new-only restore remaps structured cwd, preserves text, and is idempotent',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-restore-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const cache=path.join(root,'cache'),home=path.join(root,'home');await fs.mkdir(cache);const text=raw('restore-test'),digest=hash(text);await fs.writeFile(path.join(cache,digest+'.jsonl'),text);const rows=[{id:'restore-test',hash:digest,status:'new'}];const results=await restoreNew(rows,cache,home,root);assert.equal(results[0].status,'imported');const target=path.join(home,'sessions','rollout-restore-test.jsonl');const restored=await fs.readFile(target,'utf8');assert.equal(parse(restored).cwd,root);assert.deepEqual(parse(restored).messages,parse(text).messages);const again=await restoreNew(rows,cache,home,root);assert.equal(again[0].status,'skipped');assert.equal(await fs.readFile(target,'utf8'),restored);});
test('restore rejects damaged cached records and leaves target session absent',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-damaged-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const digest=hash(raw('x'));await fs.writeFile(path.join(root,digest+'.jsonl'),'broken');await assert.rejects(restoreNew([{id:'x',hash:digest,status:'new'}],root,path.join(root,'home'),root),/校验/);assert.deepEqual(await fs.readdir(path.join(root,'home','sessions')),[]);});
const raw=id=>JSON.stringify({type:'session_meta',payload:{id,cwd:'D:\\project\\example'}})+'\n'+JSON.stringify({timestamp:'2026-09-26T10:00:00Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'测试会话 <script>alert(1)</script>'}]}})+'\n';
test('conservative comparison preserves branches and recognizes exact extensions',()=>{const a=raw('session-1'),b=a+'{"type":"event_msg"}\n';assert.equal(relation(null,a),'new');assert.equal(relation(a,a),'identical');assert.equal(relation(a,b),'grow');assert.equal(relation(b,a),'ahead');assert.equal(relation(a,a.replace('测试','分叉')),'conflict');});
test('incomplete JSONL and unsafe identities are rejected',()=>{assert.throws(()=>parse(raw('../unsafe')));assert.throws(()=>parse(raw('safe')+'{"unfinished"'));assert.equal(parse(raw('safe')).messages.length,1);});
test('two independent devices share project, retain snapshots and detect corruption',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-desk-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new Store({type:'local',directory:root});await store.test();const a=parse(raw('s1'));const ca=await publish(store,[a],'project-1','示例项目','device-a');const b=parse(a.raw+'{"type":"event_msg","timestamp":"later"}\n');await publish(store,[b],'project-1','示例项目','device-b');assert.equal((await catalog(store)).length,2);const before=await fs.readFile(path.join(root,`object-${hash(a.raw)}.jsonl`),'utf8');const result=await download(store,ca,[b],path.join(root,'staging'));assert.equal(result[0].status,'ahead');assert.equal(a.raw,before);await fs.writeFile(path.join(root,`object-${hash(a.raw)}.jsonl`),'corrupted');await assert.rejects(download(store,ca,[],path.join(root,'fresh-staging')),/校验/);});
test('credentials in URLs and insecure WebDAV are refused',()=>{assert.throws(()=>new Store({type:'webdav',url:'http://example.org'}));assert.throws(()=>new Store({type:'webdav',url:'https://user:pass@example.org'}));});
test('failed upload never publishes a commit',async()=>{const names=[];const store={get:async()=>{const e=Error();e.status=404;throw e;},put:async k=>{names.push(k);throw Error('offline');}};await assert.rejects(publish(store,[parse(raw('s'))],'p','name','d'));assert.equal(names.some(n=>n.startsWith('commit-')),false);});
test('WebDAV uses authenticated requests, rejects redirects and validates round trip',async t=>{const original=global.fetch;const files=new Map();t.after(()=>{global.fetch=original;});global.fetch=async(url,options)=>{assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Basic '+Buffer.from('user:secret').toString('base64'));const name=new URL(url).pathname.split('/').at(-1);if(options.method==='PUT'){files.set(name,options.body);return new Response(null,{status:201});}if(options.method==='DELETE'){files.delete(name);return new Response(null,{status:204});}if(options.method==='PROPFIND')return new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/vault/commit-abcd.json</d:href></d:response></d:multistatus>',{status:207});return new Response(files.get(name)||'',{status:files.has(name)?200:404});};const store=new Store({type:'webdav',url:'https://example.org/vault/',username:'user',password:'secret'});await store.test();assert.equal(files.size,0);assert.deepEqual(await store.list(),['commit-abcd.json']);});
test('one cloud project carries files and conversations while later partial updates retain both histories',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-combined-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=require('../project-files.cjs'),source=path.join(root,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'notes.txt'),'project resource');
  const store=new Store({type:'local',directory:path.join(root,'cloud')});
  const combined=await publishProject(store,[parse(raw('combined'))],'combined-project','demo','device-a',await files.capture(source));
  await publishProject(store,[parse(raw('combined'))],'combined-project','demo','device-b');
  const discovered=await discoverProjects(store);assert.equal(discovered.length,2);assert.equal(new Set(discovered.map(c=>c.projectId)).size,1);
  const withFiles=discovered.find(c=>c.fileSnapshot);assert.equal(withFiles.fileSnapshot.files[0].path,'notes.txt');assert.equal(withFiles.objects.length,1);
  assert.equal((await download(projectStore(store,withFiles),withFiles,[],path.join(root,'cache')))[0].status,'new');
  assert.equal(combined.id,withFiles.id);
});

test('WebDAV rejects unusable endpoints with actionable errors before sending credentials',()=>{
 for(const url of [undefined,'','  '])assert.throws(()=>new Store({type:'webdav',url}),/请填写 WebDAV/);
 for(const url of ['dav.jianguoyun.com/dav/','D:\\Sync','[https://example.org](https://example.org)'])assert.throws(()=>new Store({type:'webdav',url}),/完整的 HTTPS/);
 for(const url of ['http://example.org/dav/','https://user:pass@example.org/'])assert.throws(()=>new Store({type:'webdav',url}),/必须使用 HTTPS/);
 for(const url of ['https://example.org/?a=b','https://example.org/#x'])assert.throws(()=>new Store({type:'webdav',url}),/查询参数/);
 const store=new Store({type:'webdav',url:'  https://dav.jianguoyun.com/dav/  '});assert.equal(store.child('SessionDesk').url,'https://dav.jianguoyun.com/dav/SessionDesk/');
});

test('scan identifies damaged files and line numbers without exposing message content',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-scan-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'archived_sessions');await fs.mkdir(dir);const file=path.join(dir,'broken.jsonl'),text=raw('broken')+'{"private":"DO_NOT_EXPOSE';await fs.writeFile(file,text);const c=require('../core.cjs'),result=await c.scan(root);assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/broken.jsonl/);assert.match(result.warnings[0],/第 3 行/);assert.ok(!result.warnings[0].includes('DO_NOT_EXPOSE'));assert.throws(()=>c.requireCompleteScan(result,root,'停止比较'),e=>e.message.includes(root)&&e.message.includes('broken.jsonl'));assert.equal(await fs.readFile(file,'utf8'),text);
});
test('scan retries incomplete writes and recognizes over-limit files without loading them',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-retry-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'sessions');await fs.mkdir(dir);const file=path.join(dir,'active.jsonl');await fs.writeFile(file,'{');const complete=new Promise(resolve=>setTimeout(()=>fs.writeFile(file,raw('active')).then(resolve),100));const c=require('../core.cjs'),result=await c.scan(root);await complete;assert.equal(result.warnings.length,0);assert.equal(result.sessions.length,1);
 const big=path.join(dir,'large.jsonl');await fs.writeFile(big,'');await fs.truncate(big,257*1048576);const oversized=await c.scan(root);assert.match(oversized.warnings[0],/large.jsonl.*257.0 MB.*256 MB/);assert.throws(()=>c.requireCompleteScan(oversized,root,'停止比较'),/large.jsonl/);
});
