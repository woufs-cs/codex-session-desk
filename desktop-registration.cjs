const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const model=require('./project-model.cjs'),core=require('./core.cjs');
const mapKeys=['local-projects','app-server-project-id-by-legacy-project-id-by-host','thread-project-assignments','thread-project-membership-host-ids'];
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
function schema(state){
 if(!object(state)||!object(state['local-projects']))throw Error('不支持或缺少桌面端登记格式，请先在 Codex 桌面端创建一个本地项目并退出后重试');
 for(const key of mapKeys)if(state[key]!==undefined&&!object(state[key]))throw Error('不支持的桌面端登记格式：'+key);
 for(const key of ['project-order','projectless-thread-ids'])if(state[key]!==undefined&&(!Array.isArray(state[key])||state[key].some(x=>typeof x!=='string')))throw Error('不支持的桌面端登记格式：'+key);
 for(const [id,p]of Object.entries(state['local-projects']))if(!object(p)||p.id!==id||typeof p.name!=='string'||!Array.isArray(p.rootPaths)||p.rootPaths.some(x=>typeof x!=='string'))throw Error('无法识别本地项目登记：'+id);
 for(const m of Object.values(state[mapKeys[1]]||{}))if(!object(m)||Object.values(m).some(x=>typeof x!=='string'))throw Error('无法识别主机项目映射');
}
function prepare(state,home,project,threadIds){
 schema(state);if(!project?.id||!project.roots?.length||project.roots.some(r=>!model.absolute(r.path)))throw Error('项目身份或目录无效');
 const next=structuredClone(state);for(const k of mapKeys)next[k]??={};next['project-order']??=[];
 const host=Object.keys(next[mapKeys[1]]).find(k=>k.startsWith('local:')&&model.same(k.slice(6),home))||'local:'+home;
 const mappings=next[mapKeys[1]][host]??={};const candidates=Object.keys(mappings).filter(k=>mappings[k]===project.id);
 if(candidates.length>1)throw Error('同一原生项目存在多个桌面登记，请先检查，未自动合并');
 const legacyId=candidates[0]||project.id;
 const existing=next['local-projects'][legacyId];
 if(!candidates.length&&existing)throw Error('桌面登记 ID 已被占用，未覆盖');
 if(existing&&!project.roots.every(r=>existing.rootPaths.some(p=>model.same(p,r.path))))throw Error('已有桌面登记目录与原生项目不同，未覆盖');
 const now=Date.now();next['local-projects'][legacyId]=existing||{id:legacyId,name:project.name,rootPaths:project.roots.map(r=>r.path),createdAt:now,updatedAt:now};mappings[legacyId]=project.id;
 if(!next['project-order'].includes(legacyId))next['project-order'].push(legacyId);
 for(const id of threadIds){const a=next['thread-project-assignments'][id],h=next['thread-project-membership-host-ids'][id];
  if(h&&h!=='local'&&h!==host)throw Error('对话属于其他主机，未覆盖：'+id);
  if(a&&(a.projectKind!=='local'||(a.projectId!==legacyId&&a.projectId!==project.id)))throw Error('对话已有其他桌面项目登记，未覆盖：'+id);
  next['thread-project-assignments'][id]={projectKind:'local',projectId:legacyId};next['thread-project-membership-host-ids'][id]='local';
 }
 if(next['projectless-thread-ids'])next['projectless-thread-ids']=next['projectless-thread-ids'].filter(id=>!threadIds.includes(id));
 return {state:next,legacyId,host};
}
async function register(home,project,threadIds,{requireStopped=require('./codex-lifecycle.cjs').requireStopped}={}){
 await requireStopped();const file=path.join(home,'.codex-global-state.json');await require('./recovery.cjs').safePath(file);
 const lock=path.join(home,'.session-desk-desktop-registration.lock');const handle=await fs.open(lock,'wx');
 try{
  if((await fs.stat(file)).size>16*1024*1024)throw Error('桌面登记文件过大，停止兼容写入');
  const original=await fs.readFile(file,'utf8'),parsed=JSON.parse(original),prepared=prepare(parsed,home,project,threadIds),next=JSON.stringify(prepared.state);
  if(JSON.stringify(parsed)===next)return {registered:true,changed:false,legacyProjectId:prepared.legacyId};
  const backup=path.join(home,'session-desk-backups','desktop-registration-'+crypto.randomUUID()+'.json');await require('./recovery.cjs').safePath(backup);await core.atomic(backup,original);
  await requireStopped();if(await fs.readFile(file,'utf8')!==original)throw Error('桌面登记在检查后变化，未写入，请退出 Codex 后重试');
  await core.atomic(file,next);if(await fs.readFile(file,'utf8')!==next)throw Error('桌面登记写入后变化，请检查登记备份：'+backup);
  return {registered:true,changed:true,legacyProjectId:prepared.legacyId,backup};
 }finally{await handle.close();await fs.unlink(lock);}
}
module.exports={schema,prepare,register};
