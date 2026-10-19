const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const io=require('./session-io.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const uuid = () => crypto.randomUUID();
const MAX_SESSION_BYTES=256*1024*1024;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
async function walk(dir) {
  const result = [];
  for (const e of await fs.readdir(dir, {withFileTypes:true}).catch(e => {if(e.code==='ENOENT') return []; throw e;})) {
    if(e.isSymbolicLink()) continue;
    const p = path.join(dir,e.name);
    if(e.isDirectory()) result.push(...await walk(p));
    else if(e.isFile() && e.name.endsWith('.jsonl')) result.push(p);
  }
  return result;
}
function parse(raw, file='') {
  let meta,last,start=0,lineNumber=0;const messages=[];
  while(start<raw.length){
    const newline=raw.indexOf('\n',start),end=newline===-1?raw.length:newline;
    let line=raw.slice(start,end);if(line.endsWith('\r'))line=line.slice(0,-1);start=end+1;lineNumber++;if(!line)continue;
    let r;try{r=JSON.parse(line);}catch{throw Error(`第 ${lineNumber} 行不是完整有效的 JSON${lineNumber===1&&line.charCodeAt(0)===0xfeff?'（文件带 UTF-8 BOM，可能来自旧脚本）':'（可能被截断或正在写入）'}`);}
    if(r?.type==='session_meta'&&!meta)meta=r.payload;last=r;
    const p=r?.payload;
    if(r?.type==='response_item' && p?.type==='message' && ['user','assistant'].includes(p.role)) {
      const text=(p.content || []).filter(c=>['input_text','output_text','text'].includes(c.type)).map(c=>c.text || '').join('\n');
      if(text) messages.push({role:p.role,text});
    }
  }
  if(!meta || !validId(meta.id || meta.session_id)) throw Error('无法识别会话格式');
  const title=messages.find(m=>m.role==='user' && !m.text.startsWith('<') && !m.text.startsWith('# AGENTS'))?.text.slice(0,100) || '未命名会话';
  return {id:meta.id || meta.session_id,cwd:meta.cwd || '',title,messages,file,archived:file.split(path.sep).includes('archived_sessions'),subagent:JSON.stringify(meta.source || '').includes('subagent'),updated:last?.timestamp || '',raw};
}
const scanCache=new Map();
function seedScanCache(entries){for(const [key,value] of entries||[])scanCache.set(key,value);while(scanCache.size>5000)scanCache.delete(scanCache.keys().next().value);}
function exportScanCache(){return [...scanCache].slice(-5000);}
async function scan(home,{previewLimit=64*1024,onProgress=()=>{}}={}) {
  const sessions=[],warnings=[];let retained=0,previewBudget=4*1024*1024;
  const files=[...await walk(path.join(home,'sessions')),...await walk(path.join(home,'archived_sessions'))];let scanned=0;for(const file of files) {onProgress({stage:'扫描本机对话',current:scanned++,total:files.length,detail:path.basename(file)});
    for(let attempt=0;attempt<2;attempt++){
      try {const stat=await fs.stat(file); if(stat.size>MAX_SESSION_BYTES) {warnings.push(`${path.relative(home,file)}：大小 ${(stat.size/1048576).toFixed(1)} MB，超过当前 256 MB 读取限制`);break;}
        const signature=[stat.size,stat.mtimeMs,stat.ctimeMs,stat.ino].join(':'),cached=scanCache.get(file);
        const session=previewLimit===0&&cached?.signature===signature?structuredClone(cached.session):await io.inspect(file,{previewLimit:Math.min(previewLimit,previewBudget)});
        const after=await fs.stat(file);if([after.size,after.mtimeMs,after.ctimeMs,after.ino].join(':')!==signature)throw Error('文件正在变化，请结束对话后刷新');
        session.bytes=stat.size;scanCache.set(file,{signature,session:{...session,messages:[],raw:undefined}});if(scanCache.size>5000)scanCache.delete(scanCache.keys().next().value);
        previewBudget-=session.messages.reduce((n,m)=>n+m.text.length,0);if(previewLimit>0&&stat.size<=256*1024&&retained+stat.size<=4*1024*1024){session.raw=await fs.readFile(file,'utf8');retained+=stat.size;}sessions.push(session);break;
      }catch(e){
        if(!attempt){await new Promise(resolve=>setTimeout(resolve,200));continue;}
        const reason=['EACCES','EPERM'].includes(e.code)?'访问被拒绝，请检查文件权限':e.code==='ENOENT'?'文件已移动或删除，请刷新后重试':e.code?`读取失败（${e.code}）`:e.message;
        warnings.push(`${path.relative(home,file)}：${reason}`);
      }
    }
  }
  sessions.sort((a,b)=>require('./time-format.js').timestamp(b.updated)-require('./time-format.js').timestamp(a.updated));
  return {sessions,warnings};
}
function requireCompleteScan(result,home,action){
  if(!result.warnings.length)return;
  throw Error(`${action}：${result.warnings.length} 个会话文件读取异常。\n检查目录：${home}\n${result.warnings.slice(0,12).map(w=>'• '+w).join('\n')}${result.warnings.length>12?'\n（仅显示前 12 项）':''}\n请完全退出 Codex，确认文件已下载到本机，再重试。若仍失败，请复制上述文件名和原因；不要删除或覆盖原始对话。`);
}
function mapRecord(r,cwd,rootMappings=[]){
  const m=require('./project-model.cjs');
  const globalMap=p=>{if(typeof p!=='string')return p;for(const mapping of [...rootMappings].sort((a,b)=>b.sourcePath.length-a.sourcePath.length)){const rel=m.relative(mapping.sourcePath,p);if(rel!==null)return (/^[a-z]:|^\\\\/i.test(mapping.targetPath)?path.win32:path.posix).join(mapping.targetPath,...rel.split('/').filter(Boolean));}return p;};
  const context=['session_meta','turn_context'].includes(r.type)?r.payload:r.type==='event_msg'?r.payload?.thread_settings:null;
  if(context){
    const old=context.cwd;
    if(typeof old==='string'){
      context.cwd=cwd;
      for(const key of ['workspace_roots','runtime_workspace_roots'])if(Array.isArray(context[key]))context[key]=context[key].map(p=>{const mapped=globalMap(p);return m.same(mapped,globalMap(old))?cwd:mapped;});
      const remap=p=>{const mapped=globalMap(p),base=globalMap(old);return typeof mapped==='string'&&(mapped===base||mapped.startsWith(base+'\\')||mapped.startsWith(base+'/'))?cwd+mapped.slice(base.length):mapped;};
      for(const entries of [context.permission_profile?.file_system?.entries,context.file_system_sandbox_policy?.entries])if(Array.isArray(entries))for(const entry of entries)if(entry.path&&typeof entry.path.path==='string')entry.path.path=remap(entry.path.path);
    }
  }
  const environment=r.type==='world_state'&&r.payload?.state?.environments?.environments?.local;
  if(environment&&typeof environment.cwd==='string')environment.cwd=cwd;
  return r;
}
function relation(local,remote,rootMappings=[]) {
  if(!local) return 'new';
  // Conservative: unknown metadata changes remain conflicts, never strip execution state.
  const normalize=(text,mappings=[])=>text.trimEnd().split(/\r?\n/).map(line=>{
    try {const record=mapRecord(JSON.parse(line),'[local-project-path]',mappings);if(record.type==='session_meta')for(const k of ['project_id','projectId'])delete record.payload[k];return JSON.stringify(record);}catch{return line;}
  });
  const a=normalize(local),b=normalize(remote,rootMappings);
  const n=Math.min(a.length,b.length);
  for(let i=0;i<n;i++) if(a[i]!==b[i]) return 'conflict';
  return a.length===b.length?'identical':a.length<b.length?'grow':'ahead';
}
async function atomic(file,data) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${uuid()}.tmp`;
  try {await fs.writeFile(temp,data,{flag:'wx'});await fs.rename(temp,file);} finally {await fs.rm(temp,{force:true});}
}
class Store {
  constructor(config) {
    this.config=config;
    if(config.type==='webdav') {
      const address=typeof config.url==='string'?config.url.trim():'';
      if(!address) throw Error('请填写 WebDAV 服务地址；坚果云可点击“使用坚果云地址”。');
      if(address.includes('\\') || /^[a-z]:/i.test(address)) throw Error('请填写完整的 HTTPS WebDAV 服务网址；本地文件夹请切换到“本地同步文件夹”。');
      let url;
      try {url=new URL(address);} catch {throw Error('WebDAV 地址格式不正确，请填写完整的 HTTPS 网址，例如 https://dav.jianguoyun.com/dav/ ，不要填写本地文件夹路径或带括号的链接。');}
      if(url.protocol!=='https:' || url.username || url.password) throw Error('WebDAV 必须使用 HTTPS，账号密码请单独输入');
      if(url.search || url.hash) throw Error('WebDAV 地址不能包含查询参数或 # 片段，请使用服务端提供的 WebDAV 目录地址。');
      this.url=url.href.replace(/\/+$/,'')+'/';
    } else if(!path.isAbsolute(config.directory || '')) throw Error('请选择绝对路径的同步库目录');
  }
  async request(key,method='GET',body,stream=false) {
    const headers={Authorization:'Basic '+Buffer.from(`${this.config.username || ''}:${this.config.password || ''}`).toString('base64')};
    if(method==='PROPFIND') headers.Depth='1';
    const response=await fetch(this.url+key,{method,body,headers,...(stream?{duplex:'half'}:{}),redirect:'error',signal:AbortSignal.timeout(method==='GET'||method==='PUT'?300000:30000)});
    if(!response.ok) {const e=Error(`WebDAV ${method}: HTTP ${response.status}`);e.status=response.status;throw e;}
    return response;
  }
  child(name) {
    if(!validId(name)) throw Error('无效目录名称');
    return new Store(this.config.type==='webdav'?{...this.config,url:this.url+name+'/'}:{...this.config,directory:path.join(this.config.directory,name)});
  }
  async ensure() {
    if(this.config.type!=='webdav'){await fs.mkdir(this.config.directory,{recursive:true});return;}
    try {await this.request('','MKCOL');}
    catch(e){if(e.status!==405)throw e;await this.request('','PROPFIND');}
  }
  async get(key) {
    if(this.config.type==='webdav') {
      const r=await this.request(key),chunks=[];let size=0;
      if(Number(r.headers.get('content-length'))>4*1024*1024){await r.body?.cancel();throw Error('元数据超过 4 MB 限制，请使用文件流接口读取会话');}
      if(!r.body)return '';
      for await(const chunk of r.body){size+=chunk.byteLength;if(size>4*1024*1024)throw Error('元数据超过 4 MB 限制，请使用文件流接口读取会话');chunks.push(Buffer.from(chunk));}
      return Buffer.concat(chunks,size).toString('utf8');
    }
    const f=path.join(this.config.directory,key);if((await fs.stat(f)).size>4*1024*1024) throw Error('元数据超过 4 MB 限制，请使用文件流接口读取会话');return fs.readFile(f,'utf8');
  }
  async getFile(key,target) {
    const temp=target+'.'+uuid()+'.tmp';try{
      if(this.config.type==='webdav'){const r=await this.request(key);if(Number(r.headers.get('content-length'))>MAX_SESSION_BYTES){await r.body?.cancel();throw Error('远端对象超过 256 MB 限制');}await io.writeChunks(temp,r.body||[]);}
      else await io.writeChunks(temp,io.chunks(path.join(this.config.directory,key)));
      await fs.rename(temp,target);
    }finally{await fs.rm(temp,{force:true});}
  }
  async putFile(key,source) {
    if((await fs.stat(source)).size>MAX_SESSION_BYTES)throw Error('上传对象超过 256 MB 限制');
    if(this.config.type==='webdav'){const stream=require('node:fs').createReadStream(source,{highWaterMark:65536});try{await this.request(key,'PUT',stream,true);}finally{stream.destroy();}}
    else await io.copyAtomic(source,path.join(this.config.directory,key));
  }
  async put(key,data) {
    if(Buffer.byteLength(data)>MAX_SESSION_BYTES)throw Error('上传对象超过 256 MB 限制');
    if(this.config.type==='webdav') await this.request(key,'PUT',data);
    else await atomic(path.join(this.config.directory,key),data);
  }
  async list() {
    if(this.config.type!=='webdav') return fs.readdir(this.config.directory);
    const xml=await (await this.request('','PROPFIND')).text();
    return [...xml.matchAll(/<(?:[\w-]+:)?href\b[^>]*>([^<]+)<\/(?:[\w-]+:)?href>/gi)].map(m=>decodeURIComponent(m[1].split('/').filter(Boolean).at(-1)||''));
  }
  async test() {
    const key=`probe-${uuid()}.txt`,content=uuid();
    await this.put(key,content);
    try {if(await this.get(key)!==content) throw Error('读回校验失败');await this.list();}
    finally {if(this.config.type==='webdav') await this.request(key,'DELETE');else await fs.unlink(path.join(this.config.directory,key));}
    return '连接、上传、下载校验、列目录和清理测试通过';
  }
}
function validateFileLink(link){
  if(!link)return;
  if(!['git','webdav'].includes(link.kind)||typeof link.url!=='string'||link.url.length>2048)throw Error('项目文件同步配置无效');
  if(link.kind==='git')require('./git-workflow.cjs').validUrl(link.url);
  else{const u=new URL(link.url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('项目目录地址无效');}
}
async function publish(store,sessions,projectId,name,deviceId,fileSnapshot,fileLink,definition) {
  if(!validId(projectId)||!validId(deviceId)) throw Error('项目或设备 ID 无效');
  const model=require('./project-model.cjs');if(definition)model.validateDefinition(definition);
  const objects=[];
  for(const s of sessions) {
    let digest;
    if(s.file&&store.getFile){
      const temp=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'desk-publish-'));
      try{const snapshot=path.join(temp,'snapshot.jsonl'),verify=path.join(temp,'verify.jsonl'),before=await fs.stat(s.file);await io.copyAtomic(s.file,snapshot);const after=await fs.stat(s.file);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('会话在发布期间变化，请停止任务后重试');const read=await io.inspect(snapshot,{previewLimit:0});if(read.id!==s.id||read.cwd!==s.cwd)throw Error('会话身份或目录已变化，请刷新');digest=read.digest;const key='object-'+digest+'.jsonl';
        try{await store.getFile(key,verify);if(await io.hashFile(verify)!==digest)throw Error('远端已有对象损坏');}
        catch(e){if(e.code!=='ENOENT'&&e.status!==404)throw e;await store.putFile(key,snapshot);}
        await store.getFile(key,verify);if(await io.hashFile(verify)!==digest)throw Error('上传校验失败');
      }finally{await fs.rm(temp,{recursive:true,force:true});}
    }else{parse(s.raw);digest=hash(s.raw);const key='object-'+digest+'.jsonl';try{if(hash(await store.get(key))!==digest)throw Error('远端已有对象损坏');}catch(e){if(e.code!=='ENOENT'&&e.status!==404)throw e;await store.put(key,s.raw);}if(hash(await store.get(key))!==digest)throw Error('上传校验失败');}
    const workspace=definition?model.locate(s.cwd,definition.roots):undefined;
    if(definition&&!workspace)throw Error('对话不在已定义的目录中');
    objects.push({id:s.id,hash:digest,...(s.nativeName?{name:s.nativeName}:{}),...(workspace?{workspace}:{})});
  }
  const commit={schema:1,projectId,name,deviceId,id:uuid(),created:new Date().toISOString(),objects};
  if(definition){commit.schema=2;commit.definition=definition;}
  if(fileSnapshot)commit.fileSnapshot=fileSnapshot;
  if(fileLink){validateFileLink(fileLink);commit.fileLink={kind:fileLink.kind,url:fileLink.url};}
  await store.put(`commit-${commit.id}.json`,JSON.stringify(commit));return commit;
}
async function catalog(store) {
  const entries=[];
  for(const key of (await store.list()).filter(n=>/^commit-[a-f0-9-]+\.json$/.test(n))) {
    const c=JSON.parse(await store.get(key));
    if(![1,2].includes(c.schema) || !validId(c.id) || typeof c.created!=='string' || typeof c.name!=='string' || !validId(c.projectId) || !validId(c.deviceId) || !Array.isArray(c.objects) || c.objects.length>10000) throw Error('远端清单格式不兼容');
    for(const o of c.objects) if((o.name!==undefined&&(typeof o.name!=='string'||!o.name.trim()||o.name.length>200))||!validId(o.id)||!/^[a-f0-9]{64}$/.test(o.hash)) throw Error('远端对象标识无效');
    if(new Set(c.objects.map(o=>o.id)).size!==c.objects.length)throw Error('远端项目存在重复对话');
    if(c.schema===2){const m=require('./project-model.cjs');m.validateDefinition(c.definition);for(const o of c.objects)m.validateWorkspace(o.workspace,c.definition);}
    validateFileLink(c.fileLink);
    if(c.fileSnapshot)require('./project-files.cjs').validate(c.fileSnapshot);
    entries.push(c);
  }
  return entries.sort((a,b)=>require('./time-format.js').newest(a,b));
}
async function download(store,commit,localSessions,cache,onProgress=()=>{}) {
  const rows=[];
  for(const o of commit.objects) {onProgress({stage:'下载与校验',current:rows.length,total:commit.objects.length,detail:o.name||o.id});
    const file=path.join(cache,o.hash+'.jsonl');await fs.mkdir(cache,{recursive:true});
    if(store.getFile)await store.getFile('object-'+o.hash+'.jsonl',file);else await atomic(file,await store.get('object-'+o.hash+'.jsonl'));
    const s=await io.inspect(file,{previewLimit:0}).catch(e=>{throw Error('下载校验失败：'+e.message);});if(s.digest!==o.hash)throw Error('下载校验失败，停止应用');if(s.id!==o.id)throw Error('会话 ID 与清单不符');
    if(commit.definition){const m=require('./project-model.cjs');const sourceMap=Object.fromEntries(commit.definition.roots.map(r=>[r.id,r.sourcePath]));if(!m.same(m.targetPath(o.workspace,commit.definition,sourceMap),s.cwd))throw Error('清单中的工作目录与对话记录不一致');}
    const matches=localSessions.filter(x=>x.id===s.id);
    const status=matches.length>1?'conflict':await io.compare(matches[0],s);
    rows.push({id:s.id,title:o.name||s.title,remoteName:o.name||null,status,hash:o.hash,sourceCwd:s.cwd,workspace:o.workspace});
  }
  return rows;
}
function readEnv(text) {
  const result={};
  const allowed=new Set(['WEBDAV_URL','WEBDAV_USERNAME','WEBDAV_PASSWORD']);
  for(const line of text.split(/\r?\n/)) {
    const match=line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if(!match||!allowed.has(match[1])) continue;
    let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
    result[match[1]]=value;
  }
  if(!result.WEBDAV_URL||!result.WEBDAV_USERNAME||!result.WEBDAV_PASSWORD) throw Error('缺少 WEBDAV_URL、WEBDAV_USERNAME 或 WEBDAV_PASSWORD');
  return {type:'webdav',url:result.WEBDAV_URL,username:result.WEBDAV_USERNAME,password:result.WEBDAV_PASSWORD};
}
async function restoreNew(rows,cache,home,cwd) {
  if(!path.isAbsolute(home)||!path.isAbsolute(cwd))throw Error('恢复目录必须为绝对路径');
  const existing=await scan(home);requireCompleteScan(existing,home,'停止恢复');
  const ids=new Set(existing.sessions.map(s=>s.id)),results=[];
  const dir=path.join(home,'sessions');
  await fs.mkdir(dir,{recursive:true});
  // Refuse symbolic links/junctions along the destination path.
  for(let p=dir;;p=path.dirname(p)){if((await fs.lstat(p)).isSymbolicLink())throw Error('恢复目标不能经过链接目录');if(path.dirname(p)===p)break;}
  for(const row of rows) {
    if(row.status!=='new'||ids.has(row.id)){results.push({id:row.id,status:'skipped'});continue;}
    if(!/^[a-f0-9]{64}$/.test(row.hash))throw Error('无效对象');
    const source=path.join(cache,row.hash+'.jsonl'),session=await io.inspect(source,{previewLimit:0}).catch(e=>{throw Error('暂存内容校验失败：'+e.message);});
    if(session.digest!==row.hash||session.id!==row.id)throw Error('暂存内容校验失败');
    const target=path.join(dir,'rollout-'+row.id+'.jsonl'),temp=path.join(dir,'.'+uuid()+'.tmp');
    try{await io.mapFile(source,temp,cwd);await fs.link(temp,target);}finally{await fs.rm(temp,{force:true});}
    ids.add(row.id);results.push({id:row.id,status:'imported'});
  }
  return results;
}
module.exports={MAX_SESSION_BYTES,parse,scan,relation,Store,publish,catalog,download,atomic,uuid,hash,readEnv,restoreNew,mapRecord,requireCompleteScan};

// Each project owns an independent folder; immutable commits are the discovery records.
async function initializeLibrary(store) {
  const library=store.child('SessionDesk');await library.ensure();
  const projects=library.child('projects');await projects.ensure();return projects;
}
async function publishProject(store,sessions,id,name,device,files,fileLink,definition) {
  const projects=await initializeLibrary(store),target=projects.child('p-'+id);
  await target.ensure();const manifest=files?await require('./project-files.cjs').upload(target,files):undefined;
  return {...await publish(target,sessions,id,name,device,manifest,fileLink,definition),library:true};
}
async function discoverProjects(store) {
  const projects=store.child('SessionDesk').child('projects');let names=[];
  try {names=await projects.list();}catch(e){if(e.status!==404&&e.code!=='ENOENT')throw e;}
  const result=[];
  for(const name of [...new Set(names)].filter(n=>/^p-[a-zA-Z0-9_-]{1,100}$/.test(n))) {
    for(const commit of await catalog(projects.child(name))) {
      if('p-'+commit.projectId!==name)throw Error('项目目录与版本身份不匹配');
      result.push({...commit,library:true});
    }
  }
  // Read older flat stores without moving or deleting their data.
  for(const commit of await catalog(store))result.push({...commit,library:false});
  return result.sort((a,b)=>require('./time-format.js').newest(a,b));
}
function projectStore(store,commit){return commit.library?store.child('SessionDesk').child('projects').child('p-'+commit.projectId):store;}
Object.assign(module.exports,{initializeLibrary,publishProject,discoverProjects,projectStore,seedScanCache,exportScanCache});
