function name(value){if(typeof value!=='string'||!value.trim()||value.trim().length>200)throw Error('名称需为 1–200 个字符');return value.trim();}
async function rename(request,{kind,id,value,expected}){
  value=name(value);
  if(!['project','thread'].includes(kind)||typeof id!=='string'||!id)throw Error('对象类型或身份无效');
  const read=async()=>kind==='project'?(await request('project/read',{projectId:id})).project:(await request('thread/read',{threadId:id,includeTurns:false})).thread;
  const before=await read(),current=kind==='project'?before.name:(before.name||null);
  if(current!==expected)throw Error('名称已被其他窗口修改，请刷新后重试');
  if(kind==='project')await request('project/update',{projectId:id,name:value});
  else await request('thread/name/set',{threadId:id,name:value});
  const after=await read();
  if(after.name!==value)throw Error('名称写入后尚未验证，请刷新查看；不要重复提交');
  return {before:current,after:value,kind,id};
}
async function move(request,{id,targetProjectId,expectedNativeProjectId}){
  if(typeof id!=='string'||(targetProjectId!==null&&typeof targetProjectId!=='string')||!id||targetProjectId==='')throw Error('请选择对话与目标项目');
  const before=(await request('thread/read',{threadId:id,includeTurns:false})).thread;
  if((before.projectId||null)!==(expectedNativeProjectId||null))throw Error('原生归属已变化，请刷新后重试');
  if(targetProjectId)await request('project/read',{projectId:targetProjectId||''});
  await request('thread/metadata/update',{threadId:id,projectId:targetProjectId});
  const after=(await request('thread/read',{threadId:id,includeTurns:false})).thread;
  if((after.projectId||null)!==targetProjectId||after.cwd!==before.cwd)throw Error('归属修改尚未通过验证，请刷新检查');
  return {id,projectId:targetProjectId,cwd:after.cwd};
}
module.exports={name,rename,move};
