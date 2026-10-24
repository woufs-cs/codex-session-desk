const model=require('./project-model.cjs');
const rpc=require('./codex-rpc.cjs');
const core=require('./core.cjs');
function uniquePaths(paths){return paths.filter((p,i)=>paths.findIndex(x=>model.same(p,x))===i);}
async function preflight(request,settings,rows){
  let project=null;
  if(settings.mode==='desktop'){
    if(settings.projectId){project=(await request('project/read',{projectId:settings.projectId})).project;
      if(!settings.roots.every(p=>project.roots.some(r=>model.same(r.path,p))))throw Error('所选 Codex 项目未包含映射目录，请选择正确项目或先在 Codex 添加目录');
    }else await request('project/list',{limit:1});
  }
  let existing=await rpc.pages(request,'thread/list',{useStateDbOnly:true,archived:false});
  existing.push(...await rpc.pages(request,'thread/list',{useStateDbOnly:true,archived:true}));
  if(settings.home&&settings.mode==='desktop')existing=(await require('./desktop-membership.cjs').enrich({projects:await rpc.pages(request,'project/list'),threads:existing},settings.home,[])).threads;
  const conflicts=[];for(const row of rows){const t=existing.find(t=>t.id===row.id);if(settings.mode==='desktop'&&t?.projectId&&t.membershipSource!=='desktop-directory'&&t.projectId!==project?.id)conflicts.push({id:row.id,projectId:t.projectId});}
  if(conflicts.length)throw Error('归属冲突：已有对话属于其他 Codex 项目，尚未移动。请在 Codex 中确认归属后重试：'+conflicts.map(t=>t.id).join(', '));
  return project;
}
async function reconcile(request,settings,rows,{onProject=async()=>{},onProgress=()=>{}}={}){
  let project=await preflight(request,settings,rows);
  if(settings.mode==='desktop'&&!project){
    project=(await request('project/create',{idempotencyKey:settings.key,name:settings.name,roots:uniquePaths(settings.roots).map(path=>({path})),metadata:{'session-desk.sync-id':settings.syncId}})).project;
    await onProject(project.id);
  }
  if(project){const read=(await request('project/read',{projectId:project.id})).project;if(read.id!==project.id||!settings.roots.every(p=>read.roots.some(r=>model.same(r.path,p))))throw Error('原生项目目录验证失败，请检查本机映射');}
  const results=[];
  for(const row of rows){
    let thread;onProgress({stage:"验证目录与项目归属",current:results.length,total:rows.length,detail:row.id});try{
      // Resume repairs native discovery but never starts a turn or invokes a model.
      try{thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;}catch{if(row.bytes>4*1024*1024)throw Error('会话文件已写入，但 Codex 尚未能读取元数据。为避免加载完整大对话导致内存激增，本次未自动 resume；请重新打开 Codex 后再重试验证，保留恢复报告');await request('thread/resume',{threadId:row.id,cwd:row.targetCwd,approvalPolicy:'untrusted',sandbox:'read-only'});thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;}
      if(!model.same(thread.cwd,row.targetCwd))throw Error('Codex 索引中的工作目录与预期不一致。请核对下方目录；预期正确时点击“修复这一条”，仅修复本条目录索引。预期不正确时先返回接收预览调整映射');
      if(row.targetName){await request('thread/name/set',{threadId:row.id,name:row.targetName});thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;if(thread.name!==row.targetName)throw Error('对话标题写入后未通过验证');}
      if(project){if(thread.projectId&&thread.projectId!==project.id)throw Error('对话已有其他项目归属，未覆盖');await request('thread/metadata/update',{threadId:row.id,projectId:project.id});thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;}
      results.push({id:row.id,readable:thread.id===row.id,pathMatches:model.same(thread.cwd,row.targetCwd),membership:project?thread.projectId===project.id:null,projectId:thread.projectId,cwd:thread.cwd});
    }catch(e){results.push({id:row.id,readable:thread?.id===row.id,pathMatches:thread?model.same(thread.cwd,row.targetCwd):false,membership:project?thread?.projectId===project.id:null,cwd:thread?.cwd||null,expectedCwd:row.targetCwd,error:e.message});}
  }
  if(project){const members=[...await rpc.pages(request,'thread/list',{projectId:project.id,useStateDbOnly:true,archived:false}),...await rpc.pages(request,'thread/list',{projectId:project.id,useStateDbOnly:true,archived:true})];for(const r of results)if(r.membership)r.membership=members.some(t=>t.id===r.id);}
  return {projectId:project?.id||null,mode:settings.mode,results,complete:results.every(r=>!r.error&&r.readable&&r.pathMatches&&(settings.mode!=='desktop'||r.membership))};
}
async function recoveryRows(report,ids,onProgress=()=>{}){
  const fs=require('node:fs/promises'),path=require('node:path');
  if(!report.sessionFiles){const fresh=await require('./sync-worker.cjs').run('scan',{home:report.home},onProgress);core.requireCompleteScan(fresh,report.home,'停止验证');report.sessionFiles=Object.fromEntries(fresh.sessions.map(s=>[s.id,s.file]));}
  const rows=[];for(const id of ids){
    const file=report.sessionFiles[id],relative=file&&path.relative(report.home,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!['sessions','archived_sessions'].includes(relative.split(path.sep)[0]))throw Error('恢复记录中的会话文件路径无效：'+id);
    await require('./recovery.cjs').safePath(file);
    onProgress({stage:'校验接收的对话',current:rows.length,total:ids.length,detail:id});
    const session=await require('./sync-worker.cjs').run('inspect',{file},onProgress),expected=report.expectedDirectories?.[id]||session.cwd;
    if(session.id!==id)throw Error('会话文件 ID 已变化：'+id);
    if(!session.cwd||!model.same(session.cwd,expected))throw Error('会话文件目录与接收预期不同，请重新预览映射：'+id+'；文件目录：'+session.cwd+'；预期：'+expected);
    rows.push({id,file,digest:session.digest,bytes:(await fs.stat(file)).size,targetCwd:expected,targetName:report.expectedNames?.[id]});
  }return rows;
}
async function finish(executable,report,onProject,onProgress=()=>{}){
  const rows=await recoveryRows(report,report.results.filter(r=>r.status!=='conflict').map(r=>r.id),onProgress);
  const result=await rpc.withClient(executable,report.home,request=>reconcile(request,{...report.projectSettings,home:report.home},rows,{onProject,onProgress}));
  result.nativeComplete=result.complete;result.desktopVerified=false;
  if(result.mode==='desktop'&&result.projectId){
    try{const project=await rpc.withClient(executable,report.home,async request=>(await request('project/read',{projectId:result.projectId})).project);
      result.desktopRegistration=await require('./desktop-registration.cjs').register(report.home,project,result.results.filter(r=>r.readable&&r.pathMatches&&r.membership&&!r.error).map(r=>r.id));
    }catch(e){result.desktopRegistration={registered:false,error:e.message};}
    result.complete=false; // Registry readback is not an observation of the running desktop sidebar.
  }
  return result;
}
async function repair(executable,report,id,onProgress=()=>{},services={withClient:rpc.withClient,updateIndex:require('./codex-index.cjs').update}){
  const prior=report.verification?.results?.find(r=>r.id===id);
  if(!prior||(!prior.error&&prior.readable&&prior.pathMatches&&prior.membership))throw Error('只能修复本次报告中的待处理对话');
  if(!report.results.some(r=>r.id===id&&r.status!=='conflict'))throw Error('跳过的冲突对话不能修复');
  const fs=require('node:fs/promises'),path=require('node:path'),io=require('./session-io.cjs');
  const lock=path.join(report.home,'.session-desk-restore.lock');await require('./recovery.cjs').safePath(lock);
  const handle=await fs.open(lock,'wx').catch(()=>{throw Error('恢复锁已存在，请先检查未完成的接收');});
  try{
    const [row]=await recoveryRows(report,[id],onProgress);delete row.targetName; // Directory repair must not replay an old title choice.
    const before=await services.withClient(executable,report.home,async request=>{await preflight(request,{...report.projectSettings,home:report.home},[row]);return (await request('thread/read',{threadId:id,includeTurns:false})).thread;});
    if(before.id!==id)throw Error('原生接口返回了不同的对话');
    const dir=path.join(report.home,'session-desk-backups','repair-'+core.uuid());await require('./recovery.cjs').safePath(dir);await fs.mkdir(dir,{recursive:true});
    await io.copyAtomic(row.file,path.join(dir,'original.jsonl'),{exclusive:true});if(await io.hashFile(path.join(dir,'original.jsonl'))!==row.digest||await io.hashFile(row.file)!==row.digest)throw Error('备份期间对话变化，停止修复');
    const journal={id,expectedCwd:row.targetCwd,created:new Date().toISOString(),file:row.file,state:'prepared',before:{id:before.id,cwd:before.cwd,projectId:before.projectId}},reportPath=path.join(dir,'repair.json');
    const save=()=>core.atomic(reportPath,JSON.stringify(journal,null,2));await save();let changed=false;
    try{
      if(!model.same(before.cwd,row.targetCwd)){
        onProgress({stage:'修复单条目录索引',detail:id});
        await services.updateIndex(report.home,{id,file:row.file,from:before.cwd,to:row.targetCwd},async old=>{journal.indexBefore=old;await save();});changed=true;
      }
      const result=await services.withClient(executable,report.home,request=>reconcile(request,{...report.projectSettings,home:report.home},[row],{onProgress}));
      if(!result.results[0]?.pathMatches)throw Error('修复后目录仍不匹配，已停止');
      journal.state=result.complete?'complete':'needs-review';journal.verification=result;await save();return {...result,repairReport:reportPath};
    }catch(e){
      journal.state='needs-review';journal.error=e.message;
      if(changed)try{await services.updateIndex(report.home,{id,file:row.file,from:row.targetCwd,to:before.cwd});journal.state='rolled-back';}catch(rollback){journal.rollbackError=rollback.message;}
      await save();throw Error(e.message+'；修复备份：'+reportPath);
    }
  }finally{await handle.close();await fs.unlink(lock);}
}
module.exports={preflight,reconcile,finish,recoveryRows,repair};
