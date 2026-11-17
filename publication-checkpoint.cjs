'use strict';
// An optional, replaceable accelerator. The immutable journal remains authoritative.
// Never remove journal entries or resources based on this cache.
const zlib=require('node:zlib'),{promisify}=require('node:util'),crypto=require('node:crypto');
const gzip=promisify(zlib.gzip),gunzip=promisify(zlib.gunzip);
const KEY='checkpoint-v1.json',MAX=8*1024*1024,MAX_WIRE=4*1024*1024;
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const cache=new Map();
const scope=s=>JSON.stringify([s.url||s.config?.directory,s.config?.username]);
function remember(store,rows){const key=scope(store);cache.delete(key);cache.set(key,rows);while(cache.size>2)cache.delete(cache.keys().next().value);}
async function decode(raw){
 if(Buffer.byteLength(raw)>MAX_WIRE)throw Error('检查点超过大小限制');const doc=JSON.parse(raw);
 if(doc?.version!==1||doc.encoding!=='gzip-base64'||typeof doc.data!=='string'||!Number.isSafeInteger(doc.size)||doc.size<1||doc.size>MAX)throw Error('检查点格式无效');
 const data=await gunzip(Buffer.from(doc.data,'base64'),{maxOutputLength:MAX});if(data.length!==doc.size||digest(data)!==doc.hash)throw Error('检查点完整性校验失败');
 const payload=JSON.parse(data.toString('utf8'));if(!Array.isArray(payload)||payload.length>20000)throw Error('检查点条目无效');const seen=new Set(),rows=[];
 for(const item of payload){if(typeof item.raw!=='string'||Buffer.byteLength(item.raw)>MAX_WIRE||digest(item.raw)!==item.hash||seen.has(item.hash))throw Error('检查点发布记录校验失败');seen.add(item.hash);rows.push({hash:item.hash,raw:item.raw,event:require('./project-journal.cjs').validate(JSON.parse(item.raw))});}
 // A valid checksum alone is not a valid history: validate causality and membership.
 require('./project-journal.cjs').materialize(rows);return rows;
}
async function read(store,names,hasCheckpoint){
 const known=cache.get(scope(store)),keys=new Set((known||[]).map(r=>'update-'+r.hash+'.json'));if(known&&names.filter(n=>!keys.has(n)).length<16)return known;
 if(!hasCheckpoint)return known||[];
 try{const rows=await decode(await store.get(KEY));remember(store,rows);return rows;}catch(e){if(e.status===401||e.status===403)throw e;return known||[];}
}
async function write(store,rows,{force=false}={}){
 const old=cache.get(scope(store))||[];if(!force&&(rows.length<32||rows.length-old.length<16))return {status:'not-needed',records:rows.length};
 let size=2;const items=[];for(const r of rows){const raw=r.raw||JSON.stringify(r.event);if(digest(raw)!==r.hash)throw Error('原发布记录校验失败');const item={hash:r.hash,raw};size+=Buffer.byteLength(JSON.stringify(item))+1;if(size>MAX)return {status:'size-limit',records:rows.length};items.push(item);}
 const data=Buffer.from(JSON.stringify(items)),packed=await gzip(data,{level:3}),raw=JSON.stringify({version:1,encoding:'gzip-base64',hash:digest(data),size:data.length,data:packed.toString('base64')});
 if(Buffer.byteLength(raw)>MAX_WIRE)return {status:'size-limit',records:rows.length};
 await store.put(KEY,raw);
 // Another writer may replace this optional hint. Validate what is present, never
 // require that it is our version, and never use it to authorize deletion.
 const verified=await decode(await store.get(KEY));remember(store,verified);
 return {status:'ready',records:verified.length,bytes:Buffer.byteLength(raw),originalBytes:data.length};
}
module.exports={KEY,read,write,decode};
