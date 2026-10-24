const fs=require('node:fs/promises'),native=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BYTES=256*1024*1024,MAX_LINE=8*1024*1024,PREVIEW_CHARS=64*1024;
async function* chunks(file){let size=0;for await(const chunk of native.createReadStream(file,{highWaterMark:64*1024})){size+=chunk.length;if(size>MAX_BYTES)throw Error('会话超过 256 MB 限制');yield chunk;}}
async function* lines(source){let pieces=[],length=0;for await(const chunk of source){let start=0;for(let i=0;i<chunk.length;i++)if(chunk[i]===10){const part=chunk.subarray(start,i);length+=part.length;if(length>MAX_LINE)throw Error('单条记录超过 8 MB 安全解析限制，请保留原文件并联系维护者');pieces.push(part);let line=Buffer.concat(pieces,length).toString('utf8');if(line.endsWith('\r'))line=line.slice(0,-1);yield line;pieces=[];length=0;start=i+1;}if(start<chunk.length){const part=chunk.subarray(start);length+=part.length;if(length>MAX_LINE)throw Error('单条记录超过 8 MB 安全解析限制，请保留原文件并联系维护者');pieces.push(part);}}if(length)yield Buffer.concat(pieces,length).toString('utf8');}
function record(line,n){try{return JSON.parse(line);}catch{throw Error(`第 ${n} 行不是完整有效的 JSON${n===1&&line.charCodeAt(0)===0xfeff?'（UTF-8 BOM）':''}`);}}
// Keep inline image bytes in the source file. Only a digest and byte range enter
// JSON.parse; mapping restores the original JSON string from that range.
async function* compactLines(source,nonce=crypto.randomUUID()){
 const out=Buffer.alloc(MAX_LINE);let length=0,offset=0,lineNumber=1,quoted=false,escaped=false,header='',stringStart=0,stringOffset=0,image=null,unicode=0,images=[];
 const add=b=>{if(length+b.length>MAX_LINE)throw Error('单条记录的非图片内容超过 8 MB 安全解析限制');b.copy(out,length);length+=b.length;};
 for await(const chunk of source){let imagePart=image?0:-1;
  for(let i=0;i<chunk.length;i++){
   const b=chunk[i];
   if(image){
    if(unicode){if(!((b>=48&&b<=57)||(b>=65&&b<=70)||(b>=97&&b<=102)))throw Error(`第 ${lineNumber} 行图片字符串含无效 Unicode 转义`);unicode--;}
    else if(escaped){if(![34,92,47,98,102,110,114,116,117].includes(b))throw Error(`第 ${lineNumber} 行图片字符串含无效转义`);if(b===117)unicode=4;escaped=false;}
    else if(b===92)escaped=true;
    else if(b===34){
     image.hash.update(chunk.subarray(imagePart,i+1));
     const token=`__desk_image_${nonce}_${image.hash.digest('hex')}`;
     images.push({token,start:image.start,end:offset+i});add(Buffer.from(JSON.stringify(token)));
     image=null;quoted=false;header='';imagePart=-1;continue;
    }else if(b<32)throw Error(`第 ${lineNumber} 行图片字符串含无效控制字符`);
    continue;
   }
   if(b===10){yield {line:out.subarray(0,length).toString('utf8').replace(/\r$/,''),images};length=0;images=[];lineNumber++;quoted=false;escaped=false;header='';continue;}
   if(length===MAX_LINE)throw Error('单条记录的非图片内容超过 8 MB 安全解析限制');out[length++]=b;
   if(!quoted){if(b===34){quoted=true;stringStart=length-1;stringOffset=offset+i;header='"';}continue;}
   if(header.length<256)header+=String.fromCharCode(b);else header='';
   if(escaped){escaped=false;continue;}
   if(b===92){escaped=true;continue;}
   if(b===34){quoted=false;header='';continue;}
   if(b===44&&/^"data:image\/[a-zA-Z0-9.+-]+;base64,$/.test(header)){
    image={start:stringOffset,hash:crypto.createHash('sha256').update(out.subarray(stringStart,length))};length=stringStart;imagePart=i+1;header='';
   }
  }
  if(image)image.hash.update(chunk.subarray(imagePart));offset+=chunk.length;
 }
 if(image)throw Error(`第 ${lineNumber} 行图片字符串未完整结束`);
 if(length)yield {line:out.subarray(0,length).toString('utf8'),images};
}
async function inspect(file,{previewLimit=PREVIEW_CHARS}={}){let meta,last,n=0,chars=0,messageCount=0,title='未命名会话';const messages=[],digest=crypto.createHash('sha256');
 async function* hashed(){for await(const b of chunks(file)){digest.update(b);yield b;}}
 for await(const {line} of compactLines(hashed())){n++;if(!line)continue;const r=record(line,n);if(!r||typeof r!=='object')throw Error(`第 ${n} 行不是会话记录`);if(r.type==='session_meta'&&!meta)meta=r.payload;last=r.timestamp;const p=r.payload;if(r.type==='response_item'&&p?.type==='message'&&['user','assistant'].includes(p.role)){const parts=(p.content||[]).filter(c=>['input_text','output_text','text'].includes(c.type)&&typeof c.text==='string').map(c=>c.text);if(!parts.some(Boolean))continue;messageCount++;if(title==='未命名会话'&&p.role==='user'){const first=parts.find(Boolean)||'';if(!first.startsWith('<')&&!first.startsWith('# AGENTS'))title=first.slice(0,100);}if(chars<previewLimit&&messages.length<200){let text='';for(const p of parts){const remaining=previewLimit-chars-text.length;if(remaining<=0)break;text+=(text?'\n':'')+p.slice(0,remaining);}text=text.slice(0,previewLimit-chars);chars+=text.length;messages.push({role:p.role,text});}}}
 if(!meta||!/^[a-zA-Z0-9_-]{1,100}$/.test(meta.id||meta.session_id))throw Error('无法识别会话格式');return {id:meta.id||meta.session_id,cwd:meta.cwd||'',title,messages,messageCount,previewTruncated:messageCount>messages.length||chars>=previewLimit,file,archived:file.split(path.sep).includes('archived_sessions'),subagent:JSON.stringify(meta.source||'').includes('subagent'),updated:last||'',digest:digest.digest('hex')};}
async function hashFile(file){const h=crypto.createHash('sha256');for await(const b of chunks(file))h.update(b);return h.digest('hex');}
async function writeChunks(file,source){await fs.mkdir(path.dirname(file),{recursive:true});const handle=await fs.open(file,'wx');let size=0;try{for await(const b of source){size+=Buffer.byteLength(b);if(size>MAX_BYTES)throw Error('对象超过 256 MB 限制');await handle.writeFile(b);}}finally{await handle.close();}}
async function copyAtomic(source,target,{exclusive=false}={}){const temp=target+'.'+crypto.randomUUID()+'.tmp';try{await writeChunks(temp,chunks(source));if(exclusive)await fs.link(temp,target);else await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true});}}
async function* sessionLines(session){if(session.file)yield* lines(chunks(session.file));else{let start=0;const raw=session.raw||'';while(start<raw.length){let end=raw.indexOf('\n',start);if(end<0)end=raw.length;yield raw.slice(start,end).replace(/\r$/,'');start=end+1;}}}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
async function* normalized(session,mappings,nonce){let n=0;const source=session.file?chunks(session.file):[Buffer.from(session.raw||'')];for await(const {line} of compactLines(source,nonce)){n++;if(!line)continue;const r=require('./core.cjs').mapRecord(record(line,n),'[local-project-path]',mappings);if(r.type==='session_meta')for(const k of ['project_id','projectId'])delete r.payload[k];yield JSON.stringify(canonical(r));}}
async function compare(local,remote,mappings=[]){if(!local)return 'new';const nonce=crypto.randomUUID(),a=normalized(local,[],nonce),b=normalized(remote,mappings,nonce);try{while(true){const x=await a.next(),y=await b.next();if(x.done||y.done)return x.done&&y.done?'identical':x.done?'grow':'ahead';if(x.value!==y.value)return 'conflict';}}finally{await a.return();await b.return();}}
async function mapFile(source,target,cwd,id,mappings=[]){
 async function* transformed(){let n=0;for await(const {line,images} of compactLines(chunks(source))){
  n++;if(!line)continue;const r=require('./core.cjs').mapRecord(record(line,n),cwd,mappings);
  if(r.type==='session_meta'){for(const k of ['project_id','projectId'])delete r.payload[k];if(id){r.payload.id=id;if(r.payload.session_id)r.payload.session_id=id;}}
  const json=JSON.stringify(r),ranges=new Map(images.map(image=>[JSON.stringify(image.token),image]));let cursor=0;
  for(const match of json.matchAll(/"__desk_image_[a-z0-9-]+_[a-f0-9]{64}"/g)){const image=ranges.get(match[0]);if(!image)continue;yield json.slice(cursor,match.index);yield* native.createReadStream(source,{start:image.start,end:image.end,highWaterMark:64*1024});cursor=match.index+match[0].length;}
  yield json.slice(cursor)+'\n';
 }}await writeChunks(target,transformed());
}
module.exports={MAX_BYTES,MAX_LINE,inspect,hashFile,chunks,lines,compactLines,writeChunks,copyAtomic,compare,mapFile};
