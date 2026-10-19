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
  if(settings.home)existing=(await require('./desktop-membership.cjs').enrich({projects:await rpc.pages(request,'project/list'),threads:existing},settings.home)).threads;
  const conflicts=[];for(const row of rows){const t=existing.find(t=>t.id===row.id);if(settings.mode==='desktop'&&t?.projectId&&t.membershipSource!=='desktop-directory'&&t.projectId!==project?.id)conflicts.push({id:row.id,projectId:t.projectId});}
  if(conflicts.length)throw Error('归属冲突：已有对话属于其他 Codex 项目，尚未移动。请在 Codex 中确认归属后重试：'+conflicts.map(t=>t.id).join(', '));
  return project;
}
async function reconcile(request,settings,rows,{onProject=async()=>{}}={}){
  let project=await preflight(request,settings,rows);
  if(settings.mode==='desktop'&&!project){
    project=(await request('project/create',{idempotencyKey:settings.key,name:settings.name,roots:uniquePaths(settings.roots).map(path=>({path})),metadata:{'session-desk.sync-id':settings.syncId}})).project;
    await onProject(project.id);
  }
  if(project){const read=(await request('project/read',{projectId:project.id})).project;if(read.id!==project.id||!settings.roots.every(p=>read.roots.some(r=>model.same(r.path,p))))throw Error('原生项目目录验证失败，请检查本机映射');}
  const results=[];
  for(const row of rows){
    try{
      // Resume repairs native discovery but never starts a turn or invokes a model.
      let thread;try{thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;}catch{await request('thread/resume',{threadId:row.id,cwd:row.targetCwd,approvalPolicy:'untrusted',sandbox:'read-only'});thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;}
      if(!model.same(thread.cwd,row.targetCwd))throw Error('Codex 工作目录与预览不一致');
      if(row.targetName){await request('thread/name/set',{threadId:row.id,name:row.targetName});thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;if(thread.name!==row.targetName)throw Error('对话标题写入后未通过验证');}
      if(project){if(thread.projectId&&thread.projectId!==project.id)throw Error('对话已有其他项目归属，未覆盖');await request('thread/metadata/update',{threadId:row.id,projectId:project.id});thread=(await request('thread/read',{threadId:row.id,includeTurns:false})).thread;}
      results.push({id:row.id,readable:thread.id===row.id,pathMatches:model.same(thread.cwd,row.targetCwd),membership:project?thread.projectId===project.id:null,projectId:thread.projectId,cwd:thread.cwd});
    }catch(e){results.push({id:row.id,readable:false,error:e.message});}
  }
  if(project){const members=[...await rpc.pages(request,'thread/list',{projectId:project.id,useStateDbOnly:true,archived:false}),...await rpc.pages(request,'thread/list',{projectId:project.id,useStateDbOnly:true,archived:true})];for(const r of results)if(r.membership)r.membership=members.some(t=>t.id===r.id);}
  return {projectId:project?.id||null,mode:settings.mode,results,complete:results.every(r=>r.readable&&r.pathMatches&&(settings.mode!=='desktop'||r.membership))};
}
async function finish(executable,report,onProject){
  const fresh=await core.scan(report.home),ids=report.results.filter(r=>r.status!=='conflict').map(r=>r.id);
  const rows=ids.map(id=>{const current=fresh.sessions.find(s=>s.id===id)?.cwd,expected=report.expectedDirectories?.[id]||current;if(!current||!model.same(current,expected))throw Error('恢复后的目录已变化，请重新比较：'+id);return {id,targetCwd:expected,targetName:report.expectedNames?.[id]};});
  return rpc.withClient(executable,report.home,request=>reconcile(request,{...report.projectSettings,home:report.home},rows,{onProject}));
}
module.exports={preflight,reconcile,finish};
