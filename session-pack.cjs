'use strict';
// Transport-only format. Reconstruction preserves every original byte, including
// JSON whitespace, escaping, CRLF, and the absence of a trailing newline.
const fs=require('node:fs/promises'),native=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises'),io=require('./session-io.cjs');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex'),validHash=h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h);
const MAX_REFS=20000,MAX_MANIFEST=4*1024*1024;
async function* range(file,start,end){if(end>start)yield* native.createReadStream(file,{start,end:end-1,highWaterMark:65536});}
async function compress(source,target){await pipeline(Readable.from(source),zlib.createGzip({level:3}),native.createWriteStream(target,{flags:'wx'}));}
async function unpack(source,target,expected,onProgress=()=>{}){
 let size=0;const hash=crypto.createHash('sha256');
 const count=new Transform({transform(b,_e,cb){size+=b.length;if(size>expected.size||size>io.MAX_BYTES)return cb(Error('解压内容超过声明大小'));hash.update(b);onProgress(size);cb(null,b);}});
 await pipeline(native.createReadStream(source),zlib.createGunzip(),count,native.createWriteStream(target,{flags:'wx'}));
 if(size!==expected.size||hash.digest('hex')!==expected.hash)throw Error('资源解压完整性校验失败');
}
function validate(m,hash){
 if(m?.version!==1||m.hash!==hash||!validHash(m.hash)||!Number.isSafeInteger(m.size)||m.size<1||m.size>io.MAX_BYTES||!validHash(m.text?.hash)||!Number.isSafeInteger(m.text.size)||m.text.size<0||m.text.size>m.size||!Array.isArray(m.images)||m.images.length>MAX_REFS)throw Error('压缩会话清单无效');
 let end=0,total=0;const sizes=new Map();for(const r of m.images){if(!validHash(r.hash)||!Number.isSafeInteger(r.offset)||!Number.isSafeInteger(r.size)||r.offset<end||r.size<1||r.offset+r.size>m.size)throw Error('图片位置或大小无效');if(sizes.has(r.hash)&&sizes.get(r.hash)!==r.size)throw Error('相同图片的大小不一致');sizes.set(r.hash,r.size);end=r.offset+r.size;total+=r.size;}
 if(total+m.text.size!==m.size)throw Error('会话重建大小不一致');return m;
}
async function build(file,dir,onProgress=()=>{}){
 const size=(await fs.stat(file)).size,hash=await io.hashFile(file),images=[],assets=new Map();
 onProgress({stage:'提取图片资源'});
 for await(const row of io.compactLines(io.chunks(file))){for(const r of row.images){if(images.length>=MAX_REFS)throw Error('图片引用超过 20000 项限制');const h=r.token.slice(-64),entry={hash:h,offset:r.start,size:r.end-r.start+1};images.push(entry);if(!assets.has(h))assets.set(h,entry);}}
 let index=0;for(const r of assets.values()){onProgress({stage:'无损压缩图片',current:index++,total:assets.size});r.file=path.join(dir,'image-'+r.hash+'.gz');await compress(range(file,r.offset,r.offset+r.size),r.file);}
 const textFile=path.join(dir,'text.gz'),textHash=crypto.createHash('sha256');let textSize=0;
 async function* text(){let cursor=0;for(const r of [...images,{offset:size,size:0}]){for await(const b of range(file,cursor,r.offset)){textHash.update(b);textSize+=b.length;yield b;}cursor=r.offset+r.size;}}
 onProgress({stage:'无损压缩对话文字'});await compress(text(),textFile);
 const textAsset={hash:textHash.digest('hex'),size:textSize,file:textFile};
 const manifest={version:1,hash,size,text:{hash:textAsset.hash,size:textSize},images:images.map(({hash,offset,size})=>({hash,offset,size}))};validate(manifest,hash);
 const raw=JSON.stringify(manifest);if(Buffer.byteLength(raw)>MAX_MANIFEST)throw Error('图片清单超过大小限制');
 return {manifest,raw,manifestHash:digest(raw),assets:[...assets.values()].map(a=>({...a,key:'image-'+a.hash+'.gz'})).concat({...textAsset,key:'text-'+textAsset.hash+'.gz'})};
}
async function publish(store,file,dir,onProgress=()=>{}){
 const pack=await build(file,dir,onProgress);let n=0;
 for(const a of pack.assets){const detail=`资源 ${++n}/${pack.assets.length}`,compressed=path.join(dir,'verify.gz'),plain=path.join(dir,'verify.raw');const report=e=>onProgress({...e,detail});
  try{let exists=true;try{await store.getFile(a.key,compressed,{stage:'检查云端资源',onProgress:report});}catch(e){if(e.status!==404&&e.code!=='ENOENT')throw e;exists=false;}
   if(!exists){await store.putFile(a.key,a.file,{stage:'上传压缩资源',onProgress:report});await store.getFile(a.key,compressed,{stage:'下载资源进行校验',onProgress:report});}
   onProgress({stage:'校验图片与文字资源',current:n-1,total:pack.assets.length,detail});await unpack(compressed,plain,a);
  }catch(e){throw Error(`资源 ${n}/${pack.assets.length}（${a.key}）失败：${e.message}`,{cause:e});}
  finally{await fs.rm(compressed,{force:true});await fs.rm(plain,{force:true});}
 }
 const key='pack-'+pack.manifestHash+'.json';onProgress({stage:'发布并校验重建清单'});await store.put(key,pack.raw);if(digest(await store.get(key))!==pack.manifestHash)throw Error('重建清单读回校验失败');
 return {encoding:'image-pack-v1',manifestHash:pack.manifestHash};
}
async function restore(store,object,target,onProgress=()=>{}){
 if(object.encoding!=='image-pack-v1'||!validHash(object.manifestHash)||!validHash(object.hash))throw Error('不支持的会话编码');
 onProgress({stage:'读取会话重建清单'});const raw=await store.get('pack-'+object.manifestHash+'.json');if(Buffer.byteLength(raw)>MAX_MANIFEST||digest(raw)!==object.manifestHash)throw Error('重建清单校验失败');const m=validate(JSON.parse(raw),object.hash);
 const cache=path.join(path.dirname(target),'image-resources');await fs.mkdir(cache,{recursive:true});const dir=await fs.mkdtemp(path.join(path.dirname(target),'unpack-'));
 try{
  const assets=[...new Map(m.images.map(r=>[r.hash,{...r,key:'image-'+r.hash+'.gz'}])).values(),{...m.text,key:'text-'+m.text.hash+'.gz'}];let n=0;
  for(const a of assets){const local=path.join(cache,a.hash),detail=`资源 ${++n}/${assets.length}`;let good=false;try{good=(await fs.stat(local)).size===a.size&&await io.hashFile(local)===a.hash;}catch{}
   if(good)continue;const zipped=path.join(dir,'resource.gz'),plain=path.join(dir,'resource.raw');
   try{await store.getFile(a.key,zipped,{stage:'下载压缩资源',onProgress:e=>onProgress({...e,detail})});onProgress({stage:'解压并校验资源',detail});await unpack(zipped,plain,a);await fs.rename(plain,local);}finally{await fs.rm(zipped,{force:true});await fs.rm(plain,{force:true});}
  }
  const prepared=path.join(dir,'restored.jsonl'),textFile=path.join(cache,m.text.hash);let position=0,textPosition=0,current=0;const fullHash=crypto.createHash('sha256');
  async function* restored(){for(const r of [...m.images,{offset:m.size,size:0}]){const length=r.offset-position;for await(const b of range(textFile,textPosition,textPosition+length)){fullHash.update(b);current+=b.length;yield b;}textPosition+=length;if(r.size)for await(const b of range(path.join(cache,r.hash),0,r.size)){fullHash.update(b);current+=b.length;yield b;}position=r.offset+r.size;onProgress({stage:'完整还原并校验会话',current,total:m.size,unit:'bytes'});}}
  await io.writeChunks(prepared,restored());if(current!==m.size||fullHash.digest('hex')!==m.hash)throw Error('完整会话还原校验失败');await fs.rename(prepared,target);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
module.exports={build,publish,restore,validate,unpack};
