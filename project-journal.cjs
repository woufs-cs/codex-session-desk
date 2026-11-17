'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),valid=h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h),missing=e=>e.code==='ENOENT'||e.status===404;
const limit=4*1024*1024;
function validate(e){
 if(e?.protocol!==1||!Array.isArray(e.parents)||e.parents.length>10000||e.parents.some(h=>!valid(h))||!e.supersedes||typeof e.supersedes!=='object'||Array.isArray(e.supersedes))throw Error('发布记录格式无效');
 require('./core.cjs').validateCommit(e.candidate);if(e.seed){require('./core.cjs').validateCommit(e.seed);if(e.parents.length||e.seed.projectId!==e.candidate.projectId)throw Error('迁移来源项目不一致');}
 const ids=new Set(e.candidate.objects.map(o=>o.id));for(const [id,refs]of Object.entries(e.supersedes))if(!ids.has(id)||!Array.isArray(refs)||refs.length>10000||refs.some(r=>typeof r!=='string'||!(/^(?:legacy:[a-f0-9]{64}|[a-f0-9]{64}:[a-zA-Z0-9_-]{1,100})$/).test(r)))throw Error('发布记录版本关系无效');
 return e;
}
async function records(store){let names;try{names=(await store.list()).filter(n=>/^update-[a-f0-9]{64}\.json$/.test(n));}catch(e){if(missing(e))return [];throw e;}names=[...new Set(names)].sort();if(names.length>20000)throw Error('发布记录超过安全读取上限');
 const root=store.config?.verificationCacheDirectory;const cache=root?path.join(root,'publication-records',hash(JSON.stringify([store.url||store.config.directory,store.config.username||'']))):null,result=[];
 let bytes=0;for(const key of names){const h=key.slice(7,-5),file=cache&&path.join(cache,key);let raw;
  if(file)try{if((await fs.stat(file)).size<=limit){const saved=await fs.readFile(file,'utf8');if(hash(saved)===h)raw=saved;}}catch{}
  if(raw===undefined){try{raw=await store.get(key);}catch(e){if(missing(e))throw Error('发布记录尚未完整同步，请稍后重新检查');throw e;}if(Buffer.byteLength(raw)>limit||hash(raw)!==h)throw Error('发布记录完整性校验失败：'+key);if(file)try{await require('./core.cjs').atomic(file,raw);}catch{}}
  bytes+=Buffer.byteLength(raw);if(bytes>32*1024*1024)throw Error('发布元数据超过 32 MB 安全读取上限');result.push({hash:h,event:validate(JSON.parse(raw))});
 }return result;
}
function materialize(records){if(!records.length)return null;const byHash=new Map(records.map(r=>[r.hash,r])),depth=new Map(),children=new Map(),remaining=new Map(),queue=[];
 for(const r of records){remaining.set(r.hash,new Set(r.event.parents).size);depth.set(r.hash,0);if(!r.event.parents.length)queue.push(r.hash);for(const p of new Set(r.event.parents)){if(!byHash.has(p))throw Error('发布记录的依赖尚未同步完整，请稍后检查');if(!children.has(p))children.set(p,[]);children.get(p).push(r.hash);}}
 for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[]){depth.set(child,Math.max(depth.get(child),depth.get(queue[i])+1));remaining.set(child,remaining.get(child)-1);if(!remaining.get(child))queue.push(child);}
 if(queue.length!==records.length)throw Error('发布记录存在循环依赖');const ordered=[...records].sort((a,b)=>depth.get(a.hash)-depth.get(b.hash)||a.hash.localeCompare(b.hash));
 const ancestor=(target,e)=>{const pending=[...e.parents],seen=new Set();while(pending.length){const h=pending.pop();if(h===target)return true;if(!seen.has(h)){seen.add(h);pending.push(...byHash.get(h).event.parents);}}return false;};
 const project=ordered[0].event.candidate.projectId,versions=new Map(),removed=new Set(),allParents=new Set();
 const put=(id,revision,o,d,meta)=>{if(!versions.has(id))versions.set(id,new Map());versions.get(id).set(revision,{revision,object:o,definition:d,deviceId:meta.deviceId,created:meta.created});};
 for(const {hash:h,event:e}of ordered){if(e.candidate.projectId!==project)throw Error('发布记录混入其他项目');for(const p of e.parents)allParents.add(p);for(const o of e.seed?.objects||[])put(o.id,'legacy:'+o.hash,o,e.seed.definition,e.seed);for(const o of e.candidate.objects)put(o.id,h+':'+o.id,o,e.candidate.definition,e.candidate);}
 for(const {event:e}of ordered)for(const [id,refs]of Object.entries(e.supersedes)){for(const ref of refs){if(!versions.get(id)?.has(ref))throw Error('被替代版本尚未完整同步，请稍后检查');if(!ref.startsWith('legacy:')&&!ancestor(ref.split(':')[0],e))throw Error('发布记录不能替代尚未观察到的并发版本');removed.add(id+'|'+ref);}}
 const latest=ordered.reduce((out,r)=>({...out,...r.event.seed,...r.event.candidate}),{});let view={...latest,objects:[],current:true};const conflicts=[],revisions={},groups=new Map();
 for(const [id,vs]of versions){const heads=[...vs.values()].filter(v=>!removed.has(id+'|'+v.revision));if(!heads.length)throw Error('对话版本关系无有效终点');revisions[id]=heads.map(v=>v.revision).sort();const content=new Map();for(const v of heads)content.set(v.object.hash,v);
  if(content.size>1){conflicts.push({id,variants:[...content.values()]});continue;}
  const v=[...content.values()][0],key=JSON.stringify(v.definition||null);if(!groups.has(key))groups.set(key,{definition:v.definition,objects:[]});groups.get(key).objects.push(v.object);
 }
 for(const group of groups.values())view=require('./project-current.cjs').combine(view,{...latest,...group},{});view.revision=ordered.length;
 view.id='j-'+hash(ordered.map(r=>r.hash).sort().join(','));view.current=true;view.journal=true;view.cloudConflicts=conflicts;view.revisions=revisions;view.heads=ordered.filter(r=>!allParents.has(r.hash)).map(r=>r.hash);delete view.legacyInherited;
 require('./core.cjs').validateCommit(view);return view;
}
async function load(store){return materialize(await records(store));}
async function publish(store,candidate,base={},legacy=null,{resolve={}}={}){
 const prior=await records(store),current=materialize(prior)||legacy,supersedes={};
 for(const o of candidate.objects){const conflict=current?.cloudConflicts?.find(c=>c.id===o.id),refs=current?.revisions?.[o.id]||[];
  if(conflict){if(JSON.stringify([...(resolve[o.id]||[])].sort())!==JSON.stringify([...refs].sort()))throw Object.assign(Error('对话 '+o.id+' 存在云端并发冲突，请先选择云端保留版本'),{code:'CLOUD_CONFLICT'});}
  else{const old=current?.objects.find(v=>v.id===o.id);if(old&&old.hash!==o.hash&&base[o.id]!==old.hash)throw Object.assign(Error('对话 '+o.id+' 已被另一台机器更新，请重新检查'),{code:'SYNC_CONFLICT'});}
  const old=current?.objects.find(v=>v.id===o.id);supersedes[o.id]=refs.length?refs:old?['legacy:'+old.hash]:[];
 }
 const seed=!prior.length&&legacy?{...legacy}:undefined;if(seed){delete seed.library;delete seed.localRef;delete seed.localPath;delete seed.legacyInherited;}
 const event={protocol:1,parents:current?.heads||[],supersedes,candidate,...(seed?{seed}:{})};validate(event);const raw=JSON.stringify(event);if(Buffer.byteLength(raw)>limit)throw Error('发布记录超过 4 MB 限制');const h=hash(raw),key='update-'+h+'.json';
 await store.put(key,raw);if(hash(await store.get(key))!==h)throw Error('发布记录读回校验失败');
 const after=await records(store);if(!after.some(r=>r.hash===h))after.push({hash:h,event});return {...materialize(after),published:true};
}
async function resolve(store,id,chosenHash,expected,device){const current=await load(store),conflict=current?.cloudConflicts.find(c=>c.id===id),variant=conflict?.variants.find(v=>v.object.hash===chosenHash);if(!variant)throw Error('云端冲突已变化，请重新检查');const candidate={schema:variant.object.encoding?3:variant.definition?2:1,id:crypto.randomUUID(),projectId:current.projectId,name:current.name,deviceId:device,created:new Date().toISOString(),objects:[variant.object],...(variant.definition?{definition:variant.definition}:{})};return publish(store,candidate,{},null,{resolve:{[id]:expected}});}
module.exports={records,materialize,load,publish,resolve,validate};
