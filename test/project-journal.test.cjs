const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const j=require('../project-journal.cjs'),c=require('../core.cjs');
const make=(id,value)=>({schema:1,id:crypto.randomUUID(),projectId:'p',name:'Project',deviceId:'device',created:new Date().toISOString(),objects:[{id,hash:c.hash(value)}]});
function memory(){const files=new Map();return {files,config:{type:'webdav'},list:async()=>[...files.keys()],get:async k=>files.get(k),put:async(k,v)=>{files.set(k,v);}};}
test('unconditional WebDAV merges simultaneous updates and resolves same-thread versions without forks',async()=>{
 const store=memory();await j.publish(store,make('a','0'));const original=await j.load(store),base={a:original.objects[0].hash};
 await Promise.all([j.publish(store,make('a','left'),base),j.publish(store,make('a','right'),base),j.publish(store,make('b','other'))]);
 let current=await j.load(store);assert.equal(current.objects.length,1);assert.equal(current.objects[0].id,'b');assert.equal(current.cloudConflicts[0].variants.length,2);
 const refs=current.revisions.a;await assert.rejects(j.publish(store,make('a','oops'),base),/并发冲突/);
 const chosen=current.cloudConflicts[0].variants[0].object.hash;current=await j.resolve(store,'a',chosen,refs,'resolver');assert.equal(current.cloudConflicts.length,0);assert.equal(current.objects.length,2);assert.equal(current.objects.find(o=>o.id==='a').hash,chosen);
 await assert.rejects(j.resolve(store,'a',chosen,refs,'resolver'),/已变化/);assert([...store.files.keys()].every(k=>k.startsWith('update-')));
 // Reverting to previously used bytes remains a new causal revision.
 current=await j.publish(store,make('a','0'),{a:chosen});assert.equal(current.objects.find(o=>o.id==='a').hash,base.a);
});
test('identical concurrent writes coalesce; stale sequential updates cannot replace a current version',async()=>{
 const store=memory();await Promise.all([j.publish(store,make('a','same')),j.publish(store,make('a','same'))]);const v=await j.load(store);assert.equal(v.objects.length,1);assert.equal(v.cloudConflicts.length,0);assert.equal(v.revisions.a.length,2);
 await j.publish(store,make('a','new'),{a:v.objects[0].hash});await assert.rejects(j.publish(store,make('a','stale'),{a:v.objects[0].hash}),e=>e.code==='SYNC_CONFLICT');
});
test('missing dependencies, malformed publication bytes, and noncausal replacements stop safely',async()=>{
 const store=memory();await j.publish(store,make('a','a'));const first=[...store.files.keys()][0];await j.publish(store,make('a','b'),{a:c.hash('a')});store.files.delete(first);await assert.rejects(j.load(store),/依赖/);
 const bad=memory();bad.files.set('update-'+c.hash('actual')+'.json','different');await assert.rejects(j.load(bad),/完整性/);
 const a={hash:'a'.repeat(64),event:{protocol:1,parents:[],supersedes:{},candidate:make('a','a')}},b={hash:'b'.repeat(64),event:{protocol:1,parents:[],supersedes:{a:[a.hash+':a']},candidate:make('a','b')}};assert.throws(()=>j.materialize([a,b]),/尚未观察/);
});
test('long dependency chains use bounded stack',async()=>{
 const rows=[];for(let i=0;i<12000;i++){const h=c.hash(String(i));rows.push({hash:h,event:{protocol:1,parents:i?[rows[i-1].hash]:[],supersedes:{},candidate:{...make('a','x'),objects:[]}}});}assert.equal(j.materialize(rows).revision,12000);
});
