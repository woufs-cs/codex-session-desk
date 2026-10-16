const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const f=require('../project-files.cjs'),c=require('../core.cjs');
test('custom exclusions reject absolute paths and retain default exclusions',async t=>{
  const {a}=await setup(t);await fs.mkdir(path.join(a,'private'));await fs.writeFile(path.join(a,'private','data'),'private');await fs.writeFile(path.join(a,'private.txt'),'keep');await fs.writeFile(path.join(a,'.env'),'secret');
  const snapshot=await f.capture(a,{exclude:['private/']});assert.deepEqual(snapshot.files.map(x=>x.path),['private.txt']);
  for(const value of ['../x','C:/x','/x','*.key'])assert.throws(()=>f.exclusions([value]));
});
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desk-files-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const a=path.join(dir,'a'),b=path.join(dir,'b'),cloud=path.join(dir,'cloud');for(const p of [a,b,cloud])await fs.mkdir(p);return {dir,a,b,store:new c.Store({type:'local',directory:cloud})};}
test('binary round trip, exclusions, update backup and local-only preservation',async t=>{
  const {dir,a,b,store}=await setup(t);await fs.writeFile(path.join(a,'image.bin'),Buffer.from([0,255,1]));await fs.writeFile(path.join(a,'.env'),'secret');await fs.mkdir(path.join(a,'.git'));await fs.writeFile(path.join(a,'.git','config'),'private');
  const snapshot=await f.capture(a);assert.equal(snapshot.files.length,1);assert.equal(snapshot.skipped.length,2);
  const manifest=await f.upload(store,snapshot),first=await f.apply(store,manifest,b,{},dir);
  assert.deepEqual(await fs.readFile(path.join(b,'image.bin')),Buffer.from([0,255,1]));
  await fs.writeFile(path.join(a,'image.bin'),'updated');const updated=await f.upload(store,await f.capture(a));
  assert.equal((await f.preview(updated,b,first.baseline))[0].status,'update');
  const second=await f.apply(store,updated,b,first.baseline,dir);assert.equal(second.results[0].status,'update');assert.deepEqual(await fs.readFile(path.join(path.dirname(second.reportPath),'0.bin')),Buffer.from([0,255,1]));
  await fs.writeFile(path.join(b,'image.bin'),'local edit');assert.equal((await f.preview(updated,b,second.baseline))[0].status,'local-ahead');
  await f.apply(store,updated,b,second.baseline,dir);assert.equal(await fs.readFile(path.join(b,'image.bin'),'utf8'),'local edit');
});
test('conflict copies are idempotent and excluded from reupload',async t=>{
  const {dir,a,b,store}=await setup(t);await fs.writeFile(path.join(a,'code.js'),'remote');await fs.writeFile(path.join(b,'code.js'),'local');const m=await f.upload(store,await f.capture(a));
  await f.apply(store,m,b,{},dir);await f.apply(store,m,b,{},dir);
  assert.equal((await fs.readdir(b)).length,2);assert.equal((await f.capture(b)).files.length,1);assert.equal(await fs.readFile(path.join(b,'code.js'),'utf8'),'local');
});
test('untrusted manifests reject traversal, secrets, device names and case collisions',()=>{
  const file=p=>({path:p,hash:'a'.repeat(64),size:1});
  for(const p of ['../x','C:/x','a\\x','.env','con.txt','a.','file:stream','.git/config'])assert.throws(()=>f.validate({version:1,files:[file(p)]}));
  assert.throws(()=>f.validate({version:1,files:[file('A'),file('a')]}));
});
test('damaged download does not write any project files',async t=>{
  const {dir,a,b,store}=await setup(t);await fs.writeFile(path.join(a,'x'),'data');const m=await f.upload(store,await f.capture(a));await store.put('file-'+m.files[0].hash+'.b64','broken');await assert.rejects(f.apply(store,m,b,{},dir),/校验/);assert.deepEqual(await fs.readdir(b),[]);
});
