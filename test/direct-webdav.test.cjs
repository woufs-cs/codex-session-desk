const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Directory,listing,endpoint,compare,preview,apply}=require('../direct-webdav.cjs');
const core=require('../core.cjs');
const service='https://example.test/dav/',url=service+'paper%20reading/';
function esc(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');}
function fake(t,initial={}){const previous=global.fetch,objects=new Map(Object.entries(initial).map(([k,v])=>[k,Buffer.from(v)])),dirs=new Set(['','sub/']);let writes=0,intercept=null;
  global.fetch=async(address,o)=>{assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Basic '+Buffer.from('u:p').toString('base64'));const rel=decodeURIComponent(new URL(address).pathname).slice('/dav/paper reading/'.length);
    if(o.method==='PROPFIND'){if(!dirs.has(rel))return new Response('',{status:404});const entry=(name,directory)=>'<d:response><d:href>'+esc('/dav/paper%20reading/'+name.split('/').map(encodeURIComponent).join('/'))+'</d:href><d:propstat><d:prop><d:resourcetype>'+(directory?'<d:collection/>':'')+'</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';let xml=entry(rel,true);for(const d of dirs)if(d!==rel&&d.startsWith(rel)&&!d.slice(rel.length).replace(/\/$/,'').includes('/'))xml+=entry(d,true);for(const name of objects.keys())if(name.startsWith(rel)&&!name.slice(rel.length).includes('/'))xml+=entry(name,false);return new Response('<d:multistatus xmlns:d="DAV:">'+xml+'</d:multistatus>',{status:207});}
    if(o.method==='MKCOL'){if(dirs.has(rel))return new Response('',{status:405});dirs.add(rel);return new Response('',{status:201});}
    if(o.method==='PUT'){if(intercept){intercept(objects,rel);intercept=null;}const old=objects.get(rel);if(o.headers['If-None-Match']==='*'&&old)return new Response('',{status:412});if(o.headers['If-Match']&&(!old||o.headers['If-Match']!=='"'+core.hash(old)+'"'))return new Response('',{status:412});writes++;objects.set(rel,Buffer.from(o.body));return new Response('',{status:201});}
    const data=objects.get(rel);return data?new Response(data,{headers:{etag:'"'+core.hash(data)+'"'}}):new Response('',{status:404});
  };t.after(()=>{global.fetch=previous;});return {objects,get writes(){return writes;},race(fn){intercept=fn;}};
}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'desk-direct-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const cwd=path.join(root,'project');await fs.mkdir(cwd);return {root,cwd,dir:new Directory({url:service,username:'u',password:'p'},url)};}
test('ordinary WebDAV directory supports binary, spaces and first-association conflicts without replacing originals',async t=>{
  const remote=fake(t,{'cloud.bin':Buffer.from([0,255,1]),'same.txt':'cloud','sub/中文 & notes.txt':'notes'}),{root,cwd,dir}=await fixture(t);
  await fs.writeFile(path.join(cwd,'same.txt'),'local');await fs.writeFile(path.join(cwd,'only-local.txt'),'upload');
  const p=await preview(dir,cwd,{},[]);assert.equal(p.rows.find(r=>r.path==='same.txt').status,'conflict');assert.equal(remote.writes,0);
  const result=await apply(dir,cwd,{},[],p.rows,root);assert.equal(result.error,null);assert.equal(await fs.readFile(path.join(cwd,'same.txt'),'utf8'),'local');assert.equal(remote.objects.get('same.txt').toString(),'cloud');assert.deepEqual(await fs.readFile(path.join(cwd,'cloud.bin')),Buffer.from([0,255,1]));assert.equal(remote.objects.get('only-local.txt').toString(),'upload');assert(!result.baseline['same.txt']);
  const again=await preview(dir,cwd,result.baseline,[]);assert.equal(again.rows.filter(r=>r.status==='identical').length,3);
});
test('established baseline supports safe bidirectional updates and rechecks preview before writing',async t=>{
  const remote=fake(t,{'up.txt':'old','down.txt':'old'}),{root,cwd,dir}=await fixture(t);await fs.writeFile(path.join(cwd,'up.txt'),'old');await fs.writeFile(path.join(cwd,'down.txt'),'old');let p=await preview(dir,cwd,{},[]),r=await apply(dir,cwd,{},[],p.rows,root);
  await fs.writeFile(path.join(cwd,'up.txt'),'new local');remote.objects.set('down.txt',Buffer.from('new remote'));p=await preview(dir,cwd,r.baseline,[]);assert.equal(p.rows.find(x=>x.path==='up.txt').status,'upload');assert.equal(p.rows.find(x=>x.path==='down.txt').status,'download');
  r=await apply(dir,cwd,r.baseline,[],p.rows,root);assert.equal(r.error,null);assert.equal(await fs.readFile(path.join(cwd,'down.txt'),'utf8'),'new remote');assert.equal(remote.objects.get('up.txt').toString(),'new local');
  p=await preview(dir,cwd,r.baseline,[]);await fs.writeFile(path.join(cwd,'up.txt'),'changed again');await assert.rejects(apply(dir,cwd,r.baseline,[],p.rows,root),/重新比较/);
});
test('concurrent remote edit rejects conditional PUT and preserves both versions',async t=>{
  const remote=fake(t,{'race.txt':'base'}),{root,cwd,dir}=await fixture(t);await fs.writeFile(path.join(cwd,'race.txt'),'new');const base={'race.txt':core.hash('base')},p=await preview(dir,cwd,base,[]);remote.race((map,name)=>map.set(name,Buffer.from('other device')));
  const result=await apply(dir,cwd,base,[],p.rows,root);assert.match(result.error,/412/);assert.equal(remote.objects.get('race.txt').toString(),'other device');assert.equal(await fs.readFile(path.join(cwd,'race.txt'),'utf8'),'new');assert.equal(result.baseline['race.txt'],base['race.txt']);
});
test('directory addresses and XML reject external, malformed and traversal entries',()=>{
  assert.throws(()=>endpoint('https://evil.test/dav/p/',service));assert.throws(()=>endpoint(service,service));assert.throws(()=>endpoint(service+'SessionDesk/',service));
  assert.throws(()=>listing('<html>login</html>',url));assert.throws(()=>listing('<!DOCTYPE x><d:multistatus/>',url));
  const xml='<d:multistatus><d:response><d:href>https://evil.test/x</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';assert.throws(()=>listing(xml,url),/跨站/);
});
test('missing files after baseline are reported rather than resurrected or deleted',()=>{
  const f={path:'a.txt',hash:'a'.repeat(64)},base={'a.txt':f.hash};assert.equal(compare({files:[f]},{files:[]},base)[0].status,'remote-missing');assert.equal(compare({files:[]},{files:[f]},base)[0].status,'local-missing');
});
test('association never creates an existing directory and overwrite requires a strong ETag',async t=>{
  fake(t);const {dir}=await fixture(t);await assert.rejects(dir.create(),/已存在/);await assert.rejects(dir.put('x',Buffer.from('data'),undefined),/ETag/);await assert.rejects(dir.put('x',Buffer.from('data'),'W/"weak"'),/ETag/);
});
test('special filenames and file-directory collisions do not corrupt the synchronization baseline',()=>{
  const f={path:'constructor',hash:'a'.repeat(64)};assert.equal(compare({files:[]},{files:[f]},{} )[0].status,'download');
  assert.throws(()=>compare({files:[{path:'folder',hash:'a'.repeat(64)}]},{files:[{path:'folder/file.txt',hash:'b'.repeat(64)}]},{}),/路径冲突/);
});
