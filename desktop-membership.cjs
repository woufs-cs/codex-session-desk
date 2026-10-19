const fs=require('node:fs/promises');
const path=require('node:path');
const {canonical,same,absolute}=require('./project-model.cjs');
const subagent=t=>!!t.subagent||/subagent/i.test(JSON.stringify(t.source||''));
// Native and explicit desktop membership win. Directory fallback is display-derived,
// requires one exact root match, and never changes native metadata.
function merge(inventory,state,home,sessions=[]){
  const projects=new Set(inventory.projects.map(p=>p.id));
  const maps=state['app-server-project-id-by-legacy-project-id-by-host']||{};
  const host=Object.keys(maps).find(k=>k.startsWith('local:')&&canonical(k.slice(6))===canonical(home));
  const migration=host?maps[host]:{};
  const threads=new Map(inventory.threads.filter(t=>!subagent(t)).map(t=>[t.id,{...t,nativeProjectId:t.projectId||null,membershipSource:t.projectId?'native':null}]));
  const histories=new Map(sessions.map(s=>[s.id,s]));
  let unresolved=0;
  for(const [id,assignment] of Object.entries(state['thread-project-assignments']||{})){
    if(assignment?.projectKind!=='local')continue;
    const thread=threads.get(id);
    if(thread?.projectId)continue; // A current native assignment takes precedence.
    const projectId=migration?.[assignment.projectId]||(projects.has(assignment.projectId)?assignment.projectId:null);
    if(!projectId||!projects.has(projectId)){unresolved++;continue;}
    const session=histories.get(id);
    if((!thread&&!session)||subagent(session||{})) {unresolved++;continue;}
    threads.set(id,{...(thread||{id,cwd:session.cwd,title:session.title,archived:!!session.archived,nativeProjectId:null}),projectId,membershipSource:'desktop-legacy'});
  }
  const projectless=new Set(state['projectless-thread-ids']||[]);let ambiguous=0;
  for(const t of threads.values()){
    if(t.projectId||projectless.has(t.id)||Object.hasOwn(state['thread-project-assignments']||{},t.id)||!absolute(t.cwd))continue;
    const hostId=state['thread-project-membership-host-ids']?.[t.id];if(hostId&&hostId!=='local'&&hostId!=='local:'+home)continue;
    const matches=inventory.projects.filter(p=>p.roots?.some(r=>same(r.path,t.cwd)));
    if(matches.length===1){t.projectId=matches[0].id;t.membershipSource='desktop-directory';}
    else if(matches.length>1){ambiguous++;t.membershipIssue='ambiguous';t.candidateProjectIds=matches.map(p=>p.id);}
  }
  return {...inventory,threads:[...threads.values()],warnings:[...(inventory.warnings||[]),...(unresolved?[`${unresolved} 条桌面端关联尚无法对应到可读取的项目或对话。`]:[]),...(ambiguous?[`${ambiguous} 条未明确归属的对话匹配多个项目目录，未自动归入。`]:[])]};
}
async function enrich(inventory,home,knownSessions){
  let state;
  try{state=JSON.parse(await fs.readFile(path.join(home,'.codex-global-state.json'),'utf8'));}
  catch(e){if(e.code==='ENOENT')state={};else return {...inventory,warnings:['桌面端历史归属记录读取失败，请检查 Codex 数据目录。']};}
  const sessions=knownSessions||(await require('./sync-worker.cjs').run('scan',{home})).sessions;
  return merge(inventory,state,home,sessions);
}
module.exports={merge,enrich};
