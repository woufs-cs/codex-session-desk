const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),io=require('../session-io.cjs'),c=require('../core.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desk-stream-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('UTF-8 characters across chunks and final non-newline records remain intact',async()=>{const bytes=Buffer.from('测试🙂\r\n最后一行');async function* source(){for(let i=0;i<bytes.length;i+=2)yield bytes.subarray(i,i+2);}const result=[];for await(const line of io.lines(source()))result.push(line);assert.deepEqual(result,['测试🙂','最后一行']);});
test('single oversized records stop before whole-file allocation',async t=>{const dir=await fixture(t),file=path.join(dir,'big.jsonl');const handle=await fs.open(file,'w');try{for(let i=0;i<145;i++)await handle.writeFile('x'.repeat(65536));}finally{await handle.close();}await assert.rejects(io.inspect(file),/非图片内容超过 8 MB/);assert.equal((await fs.stat(file)).size,145*65536);});
test('message previews are capped while the full digest and count remain available',async t=>{const dir=await fixture(t),file=path.join(dir,'many.jsonl');const raw=JSON.stringify({type:'session_meta',payload:{id:'many',cwd:dir}})+'\n'+Array.from({length:300},()=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'中文'.repeat(100)}]}})).join('\n');await fs.writeFile(file,raw);const result=await io.inspect(file,{previewLimit:1024});assert.equal(result.messageCount,300);assert.ok(result.messages.reduce((n,m)=>n+m.text.length,0)<=1024);assert.ok(result.previewTruncated);assert.equal(result.digest,c.hash(raw));});
test('failed streaming download preserves previous cache and removes temporary files',async t=>{const dir=await fixture(t),target=path.join(dir,'cache'),original=global.fetch;t.after(()=>global.fetch=original);await fs.writeFile(target,'previous');global.fetch=async()=>({ok:true,headers:new Headers(),body:(async function*(){yield Buffer.from('partial');throw Error('network interrupted');})()});await assert.rejects(new c.Store({type:'webdav',url:'https://example.org/'}).getFile('object',target),/interrupted/);assert.equal(await fs.readFile(target,'utf8'),'previous');assert.deepEqual(await fs.readdir(dir),['cache']);});

test('inline image ranges survive chunk boundaries, mapping and numeric-key reordering',async t=>{
 const dir=await fixture(t),file=path.join(dir,'images.jsonl'),mapped=path.join(dir,'mapped.jsonl');
 const head=JSON.stringify({type:'session_meta',payload:{id:'images',cwd:'/source',project_id:'old'}})+'\n';
 const row='{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"图片测试🙂"},{"type":"input_image","image_url":"data:image/png;base64,AA\\/BBB=="},{"type":"input_image","image_url":"data:image/jpeg;base64,CC=="}],"extra":{"2":"data:image/png;base64,DD==","1":"data:image/png;base64,EE=="}}}';
 await fs.writeFile(file,head+row);
 const bytes=Buffer.from(head+row);async function* tiny(){for(let i=0;i<bytes.length;i+=3)yield bytes.subarray(i,i+3);}
 const compact=[];for await(const entry of io.compactLines(tiny()))compact.push(entry);
 assert.equal(compact[1].images.length,4);assert.equal(JSON.parse(compact[1].line).payload.content[0].text,'图片测试🙂');
 await io.mapFile(file,mapped,'/target','fork');const records=(await fs.readFile(mapped,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(records[0].payload.cwd,'/target');assert.equal(records[0].payload.id,'fork');assert.equal(records[0].payload.project_id,undefined);assert.deepEqual(records[1],JSON.parse(row));
 const mappedSame=path.join(dir,'same.jsonl');await io.mapFile(file,mappedSame,'/target');
 assert.equal(await io.compare({file},{file:mappedSame}),'identical');
 const changed=path.join(dir,'changed.jsonl');await fs.writeFile(changed,head+row.replace('CC==','CF=='));assert.equal(await io.compare({file},{file:changed}),'conflict');
 assert.equal((await io.inspect(file)).title,'图片测试🙂');
});
test('invalid image JSON is rejected rather than hidden by image tokens',async t=>{
 const dir=await fixture(t);for(const [index,suffix] of ['AAAA','AAAA\n"}', 'AAAA\\q"}', 'AAAA\\u00xz"}'].entries()){
  const file=path.join(dir,index+'.jsonl');await fs.writeFile(file,'{"type":"session_meta","payload":{"id":"invalid"}}\n{"image":"data:image/png;base64,'+suffix);
  await assert.rejects(io.inspect(file),/图片字符串/);
 }
});

test('an image record larger than 8 MB scans and maps without truncation',async t=>{
 const dir=await fixture(t),file=path.join(dir,'large-image.jsonl'),mapped=path.join(dir,'large-image-copy.jsonl');
 const handle=await fs.open(file,'w');try{await handle.writeFile(JSON.stringify({type:'session_meta',payload:{id:'image-large',cwd:dir}})+'\n'+ '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,');for(let i=0;i<144;i++)await handle.writeFile('A'.repeat(65536));await handle.writeFile('"}]}}\n');}finally{await handle.close();}
 const session=await io.inspect(file);assert.equal(session.id,'image-large');await io.mapFile(file,mapped,dir);assert.equal(await io.hashFile(mapped),session.digest);assert.equal(await io.compare({file},{file:mapped}),'identical');
});
