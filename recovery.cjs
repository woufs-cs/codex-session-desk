const fs=require('node:fs/promises');
const path=require('node:path');
const c=require('./core.cjs');
async function safePath(p){
  for(let current=path.resolve(p);;current=path.dirname(current)){
    try{if((await fs.lstat(current)).isSymbolicLink())throw Error('恢复路径不能经过链接');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(path.dirname(current)===current)break;
  }
}
function mapped(raw,cwd,id,rootMappings=[]){
  return raw.trimEnd().split(/\r?\n/).map(line=>{
    const r=c.mapRecord(JSON.parse(line),cwd,rootMappings);
    if(r.type==='session_meta')for(const key of ['project_id','projectId'])delete r.payload[key];
    if(id&&r.type==='session_meta'){r.payload.id=id;if(r.payload.session_id)r.payload.session_id=id;}
    return JSON.stringify(r);
  }).join('\n')+'\n';
}
function branchId(id,digest){const h=c.hash(id+digest);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
async function apply(rows,cache,home,cwd,{conflicts='keep-both'}={}){
  if(!path.isAbsolute(home)||!path.isAbsolute(cwd))throw Error('请选择绝对路径');
  if(!['keep-both','skip'].includes(conflicts))throw Error('冲突处理无效');
  await safePath(home);await fs.mkdir(home,{recursive:true});
  const lock=path.join(home,'.session-desk-restore.lock');
  const handle=await fs.open(lock,'wx').catch(()=>{throw Error('恢复锁已存在，请检查是否有未完成恢复');});
  let report;
  try{
    const local=await c.scan(home);c.requireCompleteScan(local,home,'停止恢复');
    const operations=[],results=[],seen=new Set();
    for(const row of rows){
      if(!/^[a-f0-9]{64}$/.test(row.hash))throw Error('无效校验值');
      if(seen.has(row.id))throw Error('恢复清单中存在重复会话');seen.add(row.id);
      const raw=await fs.readFile(path.join(cache,row.hash+'.jsonl'),'utf8');
      if(c.hash(raw)!==row.hash||c.parse(raw).id!==row.id)throw Error('暂存内容校验失败');
      const matches=local.sessions.filter(s=>s.id===row.id);if(matches.length>1)throw Error('本机有重复会话 ID，需先处理');
      const existing=matches[0],status=c.relation(existing?.raw,raw,row.rootMappings||[]);
      const targetCwd=row.targetCwd||cwd;
      if(!path.isAbsolute(targetCwd)||row.mappingError)throw Error('对话目录尚未映射：'+row.id);
      if(existing&&row.targetCwd&&!require('./project-model.cjs').same(existing.cwd,targetCwd))throw Error('已有对话的目录与映射不同，请先检查：'+row.id);
      if(['identical','ahead'].includes(status)||(status==='conflict'&&conflicts==='skip')){results.push({id:row.id,status});continue;}
      const id=status==='conflict'?branchId(row.id,row.hash):row.id;
      const branch=local.sessions.find(s=>s.id===id);
      if(status==='conflict'&&branch){results.push({id,status:'branch-already-present'});continue;}
      const stamp=new Date().toISOString().slice(0,19).replace(/:/g,'-');
      const target=status==='grow'?existing.file:path.join(home,'sessions',`rollout-${stamp}-${id}.jsonl`);
      await safePath(target);
      const content=mapped(raw,status==='grow'?existing.cwd:targetCwd,status==='conflict'?id:null,row.rootMappings||[]);
      operations.push({target,content,before:status==='grow'?existing.raw:null,id,sourceId:row.id,status:status==='conflict'?'branched':status==='grow'?'updated':'imported'});
    }
    const backup=path.join(home,'session-desk-backups',c.uuid());await safePath(backup);await fs.mkdir(backup,{recursive:true});
    report={created:new Date().toISOString(),state:'prepared',home,operations:[],results};
    for(const [i,op]of operations.entries()){
      if(op.before!==null)await fs.writeFile(path.join(backup,`${i}.jsonl`),op.before,{flag:'wx'});
      report.operations.push({target:op.target,id:op.id,sourceId:op.sourceId,status:op.status,beforeHash:op.before===null?null:c.hash(op.before),afterHash:c.hash(op.content),backup:op.before===null?null:`${i}.jsonl`});
    }
    const journal=path.join(backup,'report.json');await c.atomic(journal,JSON.stringify(report,null,2));
    const applied=[];
    try{
      for(const [i,op]of operations.entries()){
        await safePath(op.target);await fs.mkdir(path.dirname(op.target),{recursive:true});
        if(op.before!==null){if(c.hash(await fs.readFile(op.target,'utf8'))!==c.hash(op.before))throw Error('目标在恢复期间变化，停止写入');await c.atomic(op.target,op.content);}
        else{const temp=op.target+'.'+c.uuid()+'.tmp';try{await fs.writeFile(temp,op.content,{flag:'wx'});await fs.link(temp,op.target);}finally{await fs.rm(temp,{force:true});}}
        applied.push(op);report.operations[i].applied=true;await c.atomic(journal,JSON.stringify(report,null,2));
      }
      report.state='complete';report.results.push(...operations.map(({id,sourceId,status})=>({id,sourceId,status})));
    }catch(e){
      report.state='failed';report.error=e.message;
      for(const op of applied.reverse()){
        try{if(c.hash(await fs.readFile(op.target,'utf8'))!==c.hash(op.content))throw Error('文件再次变化，保留备份并停止回滚');if(op.before===null)await fs.unlink(op.target);else await c.atomic(op.target,op.before);}
        catch(err){report.state='needs-review';report.rollbackError=err.message;}
      }
      await c.atomic(journal,JSON.stringify(report,null,2));throw Error(`${e.message}；恢复报告：${journal}`);
    }
    await c.atomic(journal,JSON.stringify(report,null,2));
    return {...report,reportPath:journal};
  }finally{await handle.close();await fs.unlink(lock);}
}
module.exports={apply,mapped,branchId};
