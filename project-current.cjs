const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const missing=e=>e.status===404||e.code==='ENOENT';
async function read(store){
 try{if(store.config.type==='webdav'){const r=await store.request('current.json'),etag=r.headers.get('etag');let chunks=[],size=0;for await(const b of r.body){size+=b.length;if(size>4*1024*1024)throw Error('当前清单超过限制');chunks.push(Buffer.from(b));}return {value:JSON.parse(Buffer.concat(chunks).toString('utf8')),token:etag};}
 const file=path.join(store.config.directory,'current.json');if((await fs.stat(file)).size>4*1024*1024)throw Error('当前清单超过限制');const raw=await fs.readFile(file,'utf8');return {value:JSON.parse(raw),token:hash(raw)};
 }catch(e){if(missing(e))return {value:null,token:null};throw e;}
}
async function write(store,value,token){
 const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>4*1024*1024)throw Error('当前清单超过 4 MB 限制');
 if(store.config.type==='webdav'){
  if(token&&!/^"[^"\r\n]+"$/.test(token))throw Error('云盘未提供强版本标识，无法安全并发发布，请使用支持条件写入的 WebDAV');
  await store.request('current.json','PUT',raw,false,token?{'If-Match':token}:{'If-None-Match':'*'});return;
 }
 const lock=path.join(store.config.directory,'.current-write-lock');let owned=false;
 try{try{await fs.mkdir(lock);owned=true;}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('另一个设备正在发布，请稍后重试'),{status:412});throw e;}
 const current=await read(store);if(current.token!==token)throw Object.assign(Error('云端版本已变化'),{status:412});await require('./core.cjs').atomic(path.join(store.config.directory,'current.json'),raw);
 }finally{if(owned)await fs.rmdir(lock);}
}
// Require demonstrably enforced preconditions before relying on WebDAV CAS.
async function verifyCAS(store){if(store.config.type!=='webdav')return;const key='probe-cas-'+crypto.randomUUID()+'.txt';try{await store.request(key,'PUT','a',false,{'If-None-Match':'*'});for(const headers of [{'If-None-Match':'*'},{'If-Match':'"deliberately-not-the-current-version"'}]){let rejected=false;try{await store.request(key,'PUT','b',false,headers);}catch(e){if(e.status===412)rejected=true;else throw e;}if(!rejected)throw Error('此 WebDAV 不执行条件写入，已停止发布以防覆盖其他设备');}}finally{await store.request(key,'DELETE').catch(()=>{});}}
function combine(previous,candidate,base={}){
 const objects=new Map((previous?.objects||[]).map(o=>[o.id,{...o}]));
 for(const o of candidate.objects){const old=objects.get(o.id);if(old&&old.hash!==o.hash&&base[o.id]!==old.hash)throw Object.assign(Error('对话 '+o.id+' 的云端版本已变化，请检查更新并选择冲突版本'),{code:'SYNC_CONFLICT'});objects.set(o.id,{...o});}
 // Keep a source definition per member so peers with different paths do not
 // reinterpret inherited objects using the last publishing machine's roots.
 const roots=[],add=(o,d)=>{if(!d||!o.workspace)return o;const source=d.roots.find(r=>r.id===o.workspace.rootId);if(!source)throw Error('成员来源目录缺失');let r=roots.find(r=>r.sourcePath===source.sourcePath);if(!r){r={id:'root-'+roots.length,sourcePath:source.sourcePath,primary:source.primary||source.id==='root-0'};roots.push(r);}return {...o,workspace:{...o.workspace,rootId:r.id}};};
 const changed=new Set(candidate.objects.map(o=>o.id));const merged=[...objects.values()].map(o=>add(o,changed.has(o.id)?candidate.definition:previous?.definition));
 const result={...previous,...candidate,objects:merged,current:true,revision:(previous?.revision||0)+1};if(!merged.length&&candidate.definition)result.definition=candidate.definition;else if(roots.length&&merged.every(o=>o.workspace))result.definition={version:1,name:candidate.name,roots};else{delete result.definition;result.objects=merged.map(({workspace,...o})=>o);}if(result.objects.length>10000)throw Error('项目成员超过 10000 条限制');if(result.definition)require('./project-model.cjs').validateDefinition(result.definition);result.schema=result.objects.some(o=>o.encoding)?3:result.definition?2:1;return result;
}
function inheritLegacy(commits){if(commits.length===1&&commits[0].current&&!commits[0].legacyInherited)return commits[0];let result=null;for(const c of [...commits].reverse()){if(!result)result=c;else result=combine(result,c,Object.fromEntries(result.objects.map(o=>[o.id,o.hash])));}return result?{...result,current:true,legacyInherited:true}:null;}
async function commit(store,candidate,base,legacy,checked=false){if(!checked)await verifyCAS(store);for(let attempt=0;attempt<4;attempt++){const head=await read(store),previous=head.value||legacy;if(store.config.type==='webdav'&&head.value&&!head.token)throw Error('云盘未提供当前清单的版本标识，无法安全发布');const merged=combine(previous,candidate,base);delete merged.legacyInherited;try{await write(store,merged,head.token);return merged;}catch(e){if(e.status!==412||attempt===3)throw e;await new Promise(r=>setTimeout(r,25*(attempt+1)));}}}
function classify(local,remote,base){if(!local)return remote?'receive':'untracked';if(!remote)return 'publish';if(local.digest===remote.hash)return 'synced';if(!base)return 'compare';const l=local.digest!==base.local,c=remote.hash!==base.cloud;if(!l&&!c)return 'synced';if(l&&!c)return 'publish';if(!l&&c)return 'receive';return 'compare';}
module.exports={read,write,verifyCAS,combine,inheritLegacy,commit,classify};
