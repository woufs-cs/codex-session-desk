function validateProfile(options,sessions,inventory){
  if(options.mode!=='desktop')throw Error('此版本仅接入 Codex 桌面端项目');
  if(typeof options.name!=='string'||!options.name.trim()||options.name.length>200||!Array.isArray(options.threadIds))throw Error('请填写有效的项目名称并确认成员');
  const ids=[...new Set(options.threadIds)];
  if(ids.some(id=>!sessions.some(s=>s.id===id)))throw Error('部分对话记录不可用，请刷新后重试');
  if(ids.length&&!options.sourceProjectId)throw Error('请选择来源 Codex 项目');
  if(options.sourceProjectId){
    if(!inventory.projects.some(p=>p.id===options.sourceProjectId))throw Error('来源 Codex 项目不存在');
    if(ids.some(id=>!inventory.threads.some(t=>t.id===id&&t.projectId===options.sourceProjectId)))throw Error('成员必须属于选中的 Codex 项目，请刷新后重选');
  }
  return ids;
}
module.exports={validateProfile};
