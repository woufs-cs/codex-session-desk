const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const core=require('../core.cjs'),journal=require('../project-journal.cjs'),cp=require('../publication-checkpoint.cjs'),maintenance=require('../cloud-maintenance.cjs');
function store(files=new Map()){const requests=[];return {files,requests,url:'https://example.invalid/'+crypto.randomUUID()+'/',config:{type:'webdav'},list:async()=>[...files.keys()],get:async key=>{requests.push(key);if(!files.has(key))throw Object.assign(Error('missing'),{status:404});return files.get(key);},put:async(k,v)=>files.set(k,v)};}
const candidate=(id,text)=>({schema:1,id:crypto.randomUUID(),created:new Date().toISOString(),projectId:'p',name:'P',deviceId:'device',objects:[{id,hash:core.hash(text)}]});
test('automatic checkpoints begin at 32 records; decompression and individual record limits are enforced',async()=>{
 const a=store();for(let i=0;i<31;i++)await journal.publish(a,candidate('t'+i,'v'+i));assert(!a.files.has(cp.KEY));const result=await journal.publish(a,candidate('last','last'));assert.equal(result.checkpoint.status,'ready');assert.equal(result.checkpoint.records,32);
 const zlib=require('node:zlib'),bomb=Buffer.alloc(9*1024*1024,32);await assert.rejects(cp.decode(JSON.stringify({version:1,encoding:'gzip-base64',size:1,hash:core.hash('x'),data:zlib.gzipSync(bomb).toString('base64')})));
 const raw=' '.repeat(4*1024*1024+1),data=Buffer.from(JSON.stringify([{hash:core.hash(raw),raw}]));await assert.rejects(cp.decode(JSON.stringify({version:1,encoding:'gzip-base64',size:data.length,hash:core.hash(data),data:zlib.gzipSync(data).toString('base64')})),/发布记录校验/);
});
test('checkpoint cold read reduces metadata requests; delta, stale readers and corruption remain safe',async()=>{
 const a=store();for(let i=0;i<8;i++)await journal.publish(a,candidate('t'+i,'value'+i));const saved=await maintenance.checkpoint(a);assert.equal(saved.records,8);
 const b=store(a.files);await journal.load(b);assert.deepEqual(b.requests,[cp.KEY]);
 await journal.publish(a,candidate('new','new'));b.requests.length=0;const next=await journal.load(b);assert.equal(next.objects.length,9);assert.equal(b.requests.length,1);assert.match(b.requests[0],/^update-/);
 const old=next.objects.find(o=>o.id==='t0').hash;await journal.publish(a,candidate('t0','fresh'),{t0:old});await assert.rejects(journal.publish(b,candidate('t0','stale'),{t0:old}),e=>e.code==='SYNC_CONFLICT');
 a.files.set(cp.KEY,'{partial');const fresh=store(a.files);assert.equal((await journal.load(fresh)).objects.length,9);assert(fresh.requests.length>8);
 const removed=[...a.files.keys()].find(k=>k.startsWith('update-'));a.files.delete(removed);await assert.rejects(journal.load(b),/依赖|版本尚未/);
});
test('checkpoint write failure does not turn a successful publication into a failed upload',async()=>{
 const a=store(),put=a.put;a.put=async(k,v)=>{if(k===cp.KEY)throw Error('network interrupted');return put(k,v);};let last;
 for(let i=0;i<32;i++)last=await journal.publish(a,candidate('t'+i,'v'+i));assert.equal(last.published,true);assert.equal(last.checkpoint.status,'deferred');assert.equal((await journal.load(a)).objects.length,32);
});
test('concurrent replaceable checkpoints never lose new journal entries',async()=>{
 const a=store(),b=store(a.files);await journal.publish(a,candidate('a','a'));const old=await journal.records(a);await journal.publish(b,candidate('b','b'));const latest=await journal.records(b);
 await Promise.all([cp.write(a,latest,{force:true}),cp.write(b,old,{force:true})]);const reader=store(a.files);assert.equal((await journal.load(reader)).objects.length,2);
 // Checkpoint contents cannot hide missing immutable journal dependencies.
 const bogus={version:1,encoding:'gzip-base64',hash:'0'.repeat(64),size:1,data:Buffer.from('bad gzip').toString('base64')};await assert.rejects(cp.decode(JSON.stringify(bogus)));
});
test('space statistics protect shared and conflict resources without downloading bodies or deleting',async()=>{
 const a=store();const image=core.hash('image'),text=core.hash('text'),content=core.hash('original');
 const manifest={version:1,hash:content,size:5,text:{hash:text,size:2},images:[{hash:image,offset:2,size:3}]},raw=JSON.stringify(manifest),mh=core.hash(raw);
 a.files.set('pack-'+mh+'.json',raw);a.files.set('text-'+text+'.gz','text');a.files.set('image-'+image+'.gz','image');const orphan='object-'+core.hash('old')+'.jsonl';a.files.set(orphan,'old');
 await journal.publish(a,{...candidate('a','unused'),schema:3,objects:[{id:'a',hash:content,encoding:'image-pack-v1',manifestHash:mh}]});
 const base=await journal.load(a);const left=candidate('b','left'),right=candidate('b','right');for(const c of [left,right]){a.files.set('object-'+c.objects[0].hash+'.jsonl','conflict');const raw=JSON.stringify({protocol:1,parents:base.heads,supersedes:{b:[]},candidate:c});a.files.set('update-'+core.hash(raw)+'.json',raw);}
 a.request=async(key,method)=>{assert.equal(method,'PROPFIND');return new Response('<D:multistatus xmlns:D="DAV:">'+[...a.files].map(([name,value])=>'<D:response><D:href>'+a.url+name+'</D:href><D:propstat><D:prop><D:getcontentlength>'+Buffer.byteLength(value)+'</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>').join('')+'</D:multistatus>');};
 a.requests.length=0;const usage=await maintenance.analyze(a);assert(usage.stable);assert.equal(usage.current.files,3);assert.equal(usage.conflicts.files,2);assert.equal(usage.unreferenced.files,1);assert.equal(usage.unreferenced.bytes,3);assert.equal(usage.automaticDeletion,false);assert(a.files.has(orphan));assert(!a.requests.some(k=>/\.gz$|\.jsonl$/.test(k)));
});
test('WebDAV size parsing ignores other folders and failed properties, preserves unknown sizes',()=>{
 const wrap=(href,properties,status='200 OK')=>'<d:response><d:href>'+href+'</d:href><d:propstat><d:prop>'+properties+'</d:prop><d:status>HTTP/1.1 '+status+'</d:status></d:propstat></d:response>';
 const xml=wrap('/dav/p/a','<d:getcontentlength>15</d:getcontentlength>')+wrap('/dav/p/b','<d:getcontentlength>90</d:getcontentlength>','404 Not Found')+wrap('/dav/other/x','<d:getcontentlength>20</d:getcontentlength>')+wrap('/dav/p/folder/','<d:resourcetype><d:collection/></d:resourcetype>');assert.deepEqual(maintenance.parseInventory(xml,'https://example.invalid/dav/p/'),[{name:'a',bytes:15},{name:'b',bytes:null}]);
});
