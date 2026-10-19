const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage}=require('electron');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const core=require('./core.cjs');
const model=require('./project-model.cjs'),rpc=require('./codex-rpc.cjs');
const desktopState=require('./desktop-state.cjs');
const profileKey=ref=>desktopState.key(state.home,ref);
const profileFor=ref=>desktopState.get(state,ref);
const desktopBindingKey=(config,ref)=>desktopState.bindingKey(config,state.home,ref);
const desktopBinding=(config,id)=>desktopState.find(state,config,id);
async function sourceSelection(cwd,fresh){
  const profile=profileFor(cwd);if(profile?.mode!=='desktop'||!profile.sourceProjectId)throw Error('请先选择 Codex 桌面端项目并保存同步属性');const selected=model.select(fresh.sessions,profile);let roots=profile.roots||[];
  if(profile.sourceProjectId){
    const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('读取原生项目成员需要 Codex CLI');
    const inventory=await rpc.inventory(found.path,state.home),project=inventory.projects.find(p=>p.id===profile.sourceProjectId);
    if(!project)throw Error('来源 Codex 项目不存在，请重新选择');require('./desktop-policy.cjs').validateProfile(profile,fresh.sessions,inventory);roots=project.roots.map(r=>r.path);for(const s of selected){const t=inventory.threads.find(t=>t.id===s.id);if(t?.nativeName)s.nativeName=t.nativeName;}
    for(const t of inventory.threads)if(profile.threadIds.includes(t.id)&&t.projectId!==profile.sourceProjectId)throw Error('对话已移动到其他项目，请重新确认成员');
  }
  return {profile,selected,definition:model.define(profile.name,profile.cwd,roots,selected)};
}
// Software rendering avoids driver-specific initialization failures on Windows.
if(process.platform==='win32') app.disableHardwareAcceleration();
let win,state,sessions=[],commits=[],busy=false,secret='',secretScope='',plan=[];
let planProject=null,lastRecovery=null;
let filePlan=null,directPlan=null;
const localBinding=(config,id)=>Object.keys(state.bindings).map(k=>{try{const a=JSON.parse(k);return bindingKey(config,a[3])===k&&state.bindings[k]===id?a[3]:null;}catch{return null;}}).find(Boolean);
const bindingKey=(config,cwd)=>JSON.stringify([config.type,config.type==='webdav'?config.url:config.directory,config.username||'',cwd.toLowerCase()]);
const scope=c=>`${c.url || ''}\n${c.username || ''}`;
function storage(config) {return new core.Store({...config,password:config.password||(scope(config)===secretScope?secret:'')});}
const stateFile=()=>path.join(app.getPath('userData'),'settings.json');
async function save(){await core.atomic(stateFile(),JSON.stringify(state,null,2));}
let progressAt=0,progressStage='';function progress(value){const now=Date.now();if(!value.done&&value.stage===progressStage&&now-progressAt<100)return;progressAt=now;progressStage=value.stage;if(win&&!win.isDestroyed())win.webContents.send('sync-progress',value);}
function register(name,fn){ipcMain.handle(name,async(_e,...args)=>{if(busy)throw Error('有任务正在进行，请稍候');busy=true;progress({stage:({restore:'准备接收',download:'下载与比较',verifyRecovery:'准备验证'})[name]||'正在处理'});try{return await fn(...args);}finally{busy=false;progress({done:true});}});}
app.whenReady().then(async()=>{
  state=await fs.readFile(stateFile(),'utf8').then(JSON.parse).catch(()=>({deviceId:core.uuid(),home:process.env.CODEX_HOME&&path.isAbsolute(process.env.CODEX_HOME)?process.env.CODEX_HOME:path.join(os.homedir(),'.codex'),bindings:{}}));
  state.conversationProjects ||= {};
  desktopState.migrate(state);
  state.directProjects ||= {};
  state.directBaselines ||= {};
  state.localProjects ||= [];
  state.favorites ||= {};
  state.fileBaselines ||= {};
  state.projectModes ||= {};
  state.uploadExclusions ||= {};
  lastRecovery=state.lastRecovery||null;
  if(state.gitPath)require('./git-service.cjs').setExecutable(state.gitPath);
  const preferences=()=>({home:state.home,restoreHome:state.restoreHome||state.home,lastWorkspace:state.lastWorkspace||'',gitPath:state.gitPath||'git（系统 PATH）',codexPath:state.codexPath||'自动检测',exclude:state.uploadExclusions[(state.lastWorkspace||'').toLowerCase()]||[]});
  register('storageOverview',async()=>({version:app.getVersion(),deviceId:state.deviceId,sourceHome:state.home,targetHome:state.restoreHome||state.home,settings:stateFile(),staging:path.join(app.getPath('userData'),'staging'),backups:path.join(state.restoreHome||state.home,'session-desk-backups'),cloud:state.storage?.type==='webdav'?(()=>{try{return new core.Store(state.storage).url+'SessionDesk/projects/';}catch{return 'WebDAV 地址无效，请在连接设置中修改';}})():state.storage?.directory?path.join(state.storage.directory,'SessionDesk','projects'):null}));
  register('renameDesktopObject',async options=>{
    const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请先连接 Codex');
    const result=await rpc.withClient(found.path,state.home,request=>require('./desktop-properties.cjs').rename(request,options));
    plan=[];planProject=null;return result;
  });
  register('moveDesktopThread',async options=>{
    const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请先连接 Codex');
    const inventory=await rpc.inventory(found.path,state.home),thread=inventory.threads.find(t=>t.id===options.id);
    if(!thread||(thread.projectId||null)!==(options.expectedProjectId||null))throw Error('对话归属已变化，请刷新后重试');
    const backup=path.join(state.home,'session-desk-backups','membership-'+core.uuid()+'.json');await core.atomic(backup,JSON.stringify({created:new Date().toISOString(),home:state.home,thread,targetProjectId:options.targetProjectId},null,2));
    const result=await rpc.withClient(found.path,state.home,request=>require('./desktop-properties.cjs').move(request,{id:thread.id,targetProjectId:options.targetProjectId,expectedNativeProjectId:thread.membershipSource==='native'?thread.projectId:null}));
    for(const [k,p]of Object.entries(state.desktopProjects))if(JSON.parse(k)[0]===model.canonical(state.home)&&p.sourceProjectId!==result.projectId)p.threadIds=p.threadIds.filter(id=>id!==result.id);
    state.lastMembershipChange={home:state.home,thread,targetProjectId:result.projectId,backup};plan=[];planProject=null;await save();return result;
  });
  register('undoDesktopMembership',async()=>{const change=state.lastMembershipChange;if(!change||!model.same(change.home,state.home))throw Error('当前数据目录没有可撤销的归属调整');const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请先连接 Codex');await rpc.withClient(found.path,state.home,request=>require('./desktop-properties.cjs').move(request,{id:change.thread.id,targetProjectId:change.thread.nativeProjectId||null,expectedNativeProjectId:change.targetProjectId}));const inventory=await rpc.inventory(found.path,state.home),thread=inventory.threads.find(t=>t.id===change.thread.id);if((thread?.projectId||null)!==(change.thread.projectId||null))throw Error('原生归属已撤销，但显示归属发生变化，请刷新核对');for(const [k,p]of Object.entries(state.desktopProjects))if(JSON.parse(k)[0]===model.canonical(state.home)&&p.sourceProjectId!==thread?.projectId)p.threadIds=p.threadIds.filter(id=>id!==change.thread.id);state.lastMembershipChange=null;plan=[];planProject=null;await save();return '已撤销最近一条归属调整；请重新确认参与同步的对话。';});
  register('desktopWorkspace',async()=>{
    const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('尚未找到 Codex 连接程序。请打开连接设置，检测或选择 codex.exe。');
    state.codexPath=found.path;const inventory=await rpc.inventory(found.path,state.home),scanned=await core.scan(state.home);sessions=scanned.sessions;
    await save();return {home:state.home,projects:inventory.projects,threads:inventory.threads.map(t=>{const s=sessions.find(s=>s.id===t.id);return {...t,title:t.title||s?.title||'未命名对话',messages:s?.messages||[],updated:s?.updated||'',messageCount:s?.messageCount||s?.messages.length||0,previewTruncated:!!s?.previewTruncated,available:!!s};}),unassigned:inventory.threads.filter(t=>!t.projectId).length,warnings:[...scanned.warnings,...(inventory.warnings||[])]};
  });
  register('desktopStatus',async()=>{const found=await require('./codex-cli.cjs').detect(state.codexPath);if(found){state.codexPath=found.path;await save();}return {runtime:found?found.version:'尚未找到连接程序',preferences:preferences()};});
  register('conversationProject',async ref=>{const p=profileFor(ref);return p?{...p,cloudProjectId:state.storage?state.desktopBindings[desktopBindingKey(state.storage,ref)]||null:null}:null;});
  register('desktopReceive',async(config,commitId,cwd,options)=>{
    const commit=commits.find(c=>c.id===commitId);if(!commit||!path.isAbsolute(cwd)||typeof options.name!=='string'||!options.name.trim()||options.name.length>200)throw Error('请选择有效的快照、目录与项目名称');
    let native=null;const home=state.restoreHome||state.home;
    if(options.targetProjectId){const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请先设置 Codex 连接程序');native=await rpc.withClient(found.path,home,async request=>(await request('project/read',{projectId:options.targetProjectId})).project);}
    const ref=model.same(home,state.home)&&native?'codex:'+native.id:'cloud:'+commit.projectId;
    const key=desktopBindingKey(config,ref),prior=profileFor(ref)||{};
    if(state.desktopBindings[key]&&state.desktopBindings[key]!==commit.projectId){const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确认改绑'],defaultId:0,cancelId:0,message:'将这个本机目录关联到另一个云端项目？',detail:cwd+'\n不会移动文件或对话，但后续接收的项目身份会改变。'});if(answer.response!==1)return {cancelled:true};}
    const sourceProjectId=model.same(home,state.home)?native?.id||null:null;
    const next={...prior,cwd,name:options.name.trim(),mode:'desktop',sourceProjectId,targetProjectId:native?.id||null,threadIds:sourceProjectId&&prior.sourceProjectId===sourceProjectId?prior.threadIds:[],roots:native?.roots.map(r=>r.path)||[cwd],rootMap:state.desktopBindings[key]===commit.projectId?{...prior.rootMap}:{}};
    if(commit.definition?.roots[0])next.rootMap[model.canonical(commit.definition.roots[0].sourcePath)]=cwd;
    for(const old of Object.keys(state.desktopBindings)){try{const a=JSON.parse(old);if(old!==key&&desktopBindingKey(config,a[4])===old&&state.desktopBindings[old]===commit.projectId)delete state.desktopBindings[old];}catch{}}
    state.desktopBindings[key]=commit.projectId;state.desktopProjects[profileKey(ref)]=next;plan=[];planProject=null;await save();return {cwd,localRef:ref};
  });
  register('inspectCodexProjects',async(target=false)=>{const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('未找到 Codex 连接程序，请在连接设置中选择 codex.exe');state.codexPath=found.path;await save();return rpc.inventory(found.path,target?(state.restoreHome||state.home):state.home);});
  register('saveConversationProject',async(ref,options)=>{
    if(ref!=='codex:'+options.sourceProjectId)throw Error('本机项目身份无效');
    const fresh=await core.scan(state.home);let inventory={projects:[],threads:[]};
    if(options.sourceProjectId){const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请在连接设置选择 Codex 连接程序');inventory=await rpc.inventory(found.path,state.home);}
    const ids=require('./desktop-policy.cjs').validateProfile(options,fresh.sessions,inventory);
    const roots=inventory.projects.find(p=>p.id===options.sourceProjectId)?.roots.map(r=>r.path)||[];
    const cwd=roots[0];if(!cwd||!path.isAbsolute(cwd))throw Error('项目缺少有效目录');
    for(const [key,value]of Object.entries(state.desktopProjects))if(key!==profileKey(ref)&&JSON.parse(key)[0]===model.canonical(state.home)&&value.threadIds.some(id=>ids.includes(id)))throw Error('所选对话已被本应用的另一个项目管理，请先从原项目取消选择');
    const prior=profileFor(ref)||{};
    state.desktopProjects[profileKey(ref)]={...prior,cwd,name:options.name.trim(),mode:options.mode,sourceProjectId:options.sourceProjectId,targetProjectId:options.targetProjectId||null,threadIds:ids,roots};
    plan=[];planProject=null;await save();return '成员清单已确认。新对话需再次确认纳入；尚未修改 Codex 原生归属。';
  });
  register('setRestoreMapping',async(cwd,source,target)=>{if(!profileFor(cwd)||!model.absolute(source)||!path.isAbsolute(target))throw Error('请先确认项目设置及绝对路径');const p=profileFor(cwd);p.rootMap||={};p.rootMap[model.canonical(source)]=target;plan=[];planProject=null;await save();});
  register('conversationPlan',async()=>planProject?{...planProject,config:undefined,rows:plan}:null);
  register('compareConflict',async id=>{const row=plan.find(r=>r.id===id);if(!row||row.status!=='conflict')throw Error('请重新预览');const worker=require('./sync-worker.cjs');const local=row.localFile?await worker.run('inspect',{file:row.localFile}):null,remote=await worker.run('inspect',{file:path.join(app.getPath('userData'),'staging',row.hash+'.jsonl')});const summary=s=>s?{title:s.title,updated:s.updated,messageCount:s.messageCount,messages:s.messages}:null;return {local:summary(local),remote:summary(remote)};});
  register('setConflictPolicy',async(id,policy)=>{const row=plan.find(r=>r.id===id);if(!row||row.status!=='conflict'||!['keep-both','skip'].includes(policy))throw Error('请重新预览冲突');row.conflictPolicy=policy;});
  register('setTitlePolicy',async(id,policy)=>{const row=plan.find(r=>r.id===id);if(!row||!['local','remote'].includes(policy))throw Error('请重新打开预览');row.namePolicy=policy;});
  register('clearSyncPlans',async()=>{plan=[];planProject=null;filePlan=null;directPlan=null;});
  register('preferences',async()=>preferences());
  register('setupStatus',async()=>{
    const git=await require('./git-service.cjs').version().catch(()=>'未找到 Git：仅 Git 同步需要');
    const codex=await require('./codex-cli.cjs').detect(state.codexPath);if(codex)state.codexPath=codex.path;await save();
    const hasHome=await fs.stat(state.home).then(s=>s.isDirectory()).catch(()=>false);
    return {git,codex:codex?codex.version:'未找到 CLI：仅对话原生识别需要',home:hasHome?'数据目录已找到':'数据目录不存在，请选择',storage:state.storage?'连接配置已保存（未进行网络验证）':'尚未配置；仅本地浏览或 Git 同步可以跳过',preferences:preferences()};
  });
  register('chooseGit',async()=>{const chosen=await dialog.showOpenDialog(win,{title:'选择 git.exe',properties:['openFile'],filters:[{name:'Git',extensions:['exe']}]});if(chosen.canceled)return '已取消';const value=await require('./git-service.cjs').version(chosen.filePaths[0]);state.gitPath=chosen.filePaths[0];require('./git-service.cjs').setExecutable(state.gitPath);await save();return value;});
  register('chooseRestoreHome',async()=>{const chosen=await dialog.showOpenDialog(win,{title:'选择会话恢复目标 Codex 数据目录',defaultPath:state.restoreHome||state.home,properties:['openDirectory','createDirectory']});if(chosen.canceled)return null;state.restoreHome=chosen.filePaths[0];plan=[];planProject=null;await save();return state.restoreHome;});
  register('uploadExclusions',async(cwd,values)=>{if(!path.isAbsolute(cwd))throw Error('请选择本地项目');if(values!==undefined){state.uploadExclusions[cwd.toLowerCase()]=require('./project-files.cjs').exclusions(values);await save();}return state.uploadExclusions[cwd.toLowerCase()]||[];});
  register('gitIdentity',async(cwd,identity)=>{
    const service=require('./git-service.cjs');await service.root(cwd);
    if(identity){if(!identity.name?.trim()||!/^\S+@\S+$/.test(identity.email)||/[\r\n\0]/.test(identity.name))throw Error('请填写有效的提交姓名和邮箱');await service.git(cwd,['config','--local','user.name',identity.name.trim()]);await service.git(cwd,['config','--local','user.email',identity.email]);}
    return {name:(await service.git(cwd,['config','--get','user.name']).catch(()=>'')).trim(),email:(await service.git(cwd,['config','--get','user.email']).catch(()=>'')).trim()};
  });
  const directKey=(config,cwd)=>bindingKey(config,cwd);
  const directDirectory=(config,url)=>new (require('./direct-webdav.cjs').Directory)(storage(config).config,url);
  register('createLocalProject',async name=>{
    if(typeof name!=='string'||!name.trim()||name!==path.basename(name)||/[<>:"|?*\\/]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name))throw Error('请输入有效的单层文件夹名称');
    const selected=await dialog.showOpenDialog(win,{title:'选择新项目的父目录',properties:['openDirectory']});if(selected.canceled)return null;
    const cwd=path.join(selected.filePaths[0],name);await fs.mkdir(cwd);state.localProjects.push(cwd);await save();return cwd;
  });
  register('fileConnection',async(config,cwd)=>state.directProjects[directKey(config,cwd)]||null);
  register('configureFiles',async(config,cwd,options)=>{
    if(!path.isAbsolute(cwd))throw Error('请选择本地项目');directPlan=null;
    if(options.kind==='git'){
      const git=require('./git-service.cjs');
      if(options.clone){await require('./git-workflow.cjs').clone(options.url,cwd);}
      else if(options.create){try{await fs.access(path.join(cwd,'.git'));throw Error('已有 Git 仓库，请选择关联已有');}catch(e){if(e.code!=='ENOENT')throw e;}
        const parentRepo=await git.git(cwd,['rev-parse','--show-toplevel']).catch(()=>'');if(parentRepo.trim())throw Error('当前目录位于其他 Git 仓库内，请选择独立目录');
        if(options.url)require('./git-workflow.cjs').validUrl(options.url);
        await git.git(cwd,['init']);if(options.url)await require('./git-workflow.cjs').remote(cwd,'origin',options.url);
      }else await git.root(cwd);
      state.projectModes[cwd.toLowerCase()]='git';await save();return {kind:'git',message:'已使用当前 Git 仓库；远端和分支沿用原配置'};
    }
    if(config.type!=='webdav')throw Error('请先在连接设置中配置 WebDAV');
    const dir=directDirectory(config,options.url);
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确认关联'],defaultId:0,cancelId:0,message:options.create?'创建并关联云端项目目录？':'关联现有 WebDAV 项目目录？',detail:cwd+'\n↔ '+dir.url+'\n此步不会上传或覆盖项目文件；同步前先比较。请避免其他客户端同时修改此目录。'});if(answer.response!==1)return {cancelled:true};
    if(options.create)await dir.create();else await dir.list();
    const known=await core.discoverProjects(storage(config));
    const key=directKey(config,cwd),matching=known.find(c=>c.fileLink?.kind==='webdav'&&c.fileLink.url===dir.url);
    if(state.bindings[key]&&matching&&state.bindings[key]!==matching.projectId)throw Error('此目录已关联其他云端项目，请先在项目设置中明确改绑');
    const id=state.bindings[key]||matching?.projectId||core.uuid();
    const link={kind:'webdav',url:dir.url};await core.publishProject(storage(config),[],id,path.basename(cwd),state.deviceId,undefined,link);
    if(state.directProjects[key]?.url!==dir.url)delete state.directBaselines[key];
    state.directProjects[key]=link;state.bindings[key]=id;state.projectModes[cwd.toLowerCase()]='webdav';await save();return {...link,message:'已关联普通 WebDAV 目录。点击比较，再应用同步。'};
  });
  register('compareDirectory',async(config,cwd)=>{
    directPlan=null;const key=directKey(config,cwd),link=state.directProjects[key];if(!link)throw Error('请先关联 WebDAV 项目目录');
    const exclude=state.uploadExclusions[cwd.toLowerCase()]||[],result=await require('./direct-webdav.cjs').preview(directDirectory(config,link.url),cwd,state.directBaselines[key]||{},exclude);
    directPlan={config,cwd,key,url:link.url,rows:result.rows,exclude};return result.rows;
  });
  register('applyDirectory',async()=>{
    if(!directPlan)throw Error('请先比较目录差异');const p=directPlan;
    if(JSON.stringify(state.uploadExclusions[p.cwd.toLowerCase()]||[])!==JSON.stringify(p.exclude)||state.directProjects[p.key]?.url!==p.url||state.projectModes[p.cwd.toLowerCase()]!=='webdav')throw Error('关联或同步方式已改变，请重新比较');
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','应用同步'],defaultId:0,cancelId:0,message:'应用已预览的双向文件同步？',detail:p.cwd+'\n↔ '+p.url+'\n冲突与删除保持原样。先停止其他客户端写入。'});if(answer.response!==1)return '已取消';
    const result=await require('./direct-webdav.cjs').apply(directDirectory(p.config,p.url),p.cwd,state.directBaselines[p.key]||{},p.exclude,p.rows,app.getPath('userData'));
    state.directBaselines[p.key]=result.baseline;directPlan=null;await save();
    const pending=result.results.filter(r=>['conflict','local-missing','remote-missing'].includes(r.status)).length;
    return (result.error?'部分完成：'+result.error:pending?'同步已处理，仍有 '+pending+' 项冲突或删除待处理':'文件同步完成')+'。报告：'+result.reportPath;
  });
  register('projectMode',async(cwd,mode)=>{if(!path.isAbsolute(cwd)||!['git','webdav'].includes(mode))throw Error('项目设置无效');state.projectModes[cwd.toLowerCase()]=mode;await save();return '项目同步方式已保存';});
  register('getProjectMode',async cwd=>{if(!path.isAbsolute(cwd))throw Error('项目目录无效');state.lastWorkspace=cwd;if(!state.localProjects.some(p=>p.toLowerCase()===cwd.toLowerCase()))state.localProjects.push(cwd);await save();return state.projectModes[cwd.toLowerCase()]||'webdav';});
  register('gitStatus',async cwd=>{try{return await require('./git-workflow.cjs').inspect(cwd);}catch(e){throw Error(require('./git-workflow.cjs').friendly(e));}});
  register('gitWorkflow',async(cwd,kind,args={})=>{
    const workflow=require('./git-workflow.cjs'),git=require('./git-service.cjs');
    try{
      if(kind==='clone'){
        workflow.validUrl(args.url);
        const chosen=await dialog.showOpenDialog(win,{title:'选择空目录克隆仓库',properties:['openDirectory','createDirectory']});if(chosen.canceled)return {message:'已取消'};
        await workflow.clone(args.url,chosen.filePaths[0]);state.lastWorkspace=chosen.filePaths[0];state.projectModes[chosen.filePaths[0].toLowerCase()]='git';await save();return {message:'仓库克隆完成',cwd:chosen.filePaths[0]};
      }
      if(kind==='smart'){
        let s=await workflow.inspect(cwd);if(!s.remotes.length)return {message:'尚未配置远端，请展开仓库设置添加地址'};
        await git.action(cwd,'fetch');s=await workflow.inspect(cwd);
        if(!s.advice.action)return {message:s.advice.title+'。'+s.advice.detail};
        const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消',s.advice.action==='pull'?'快进拉取':'推送提交'],defaultId:0,cancelId:0,message:s.advice.title,detail:`项目：${cwd}\n分支：${s.branch}\n上游：${s.upstream}\n${s.advice.detail}`});if(answer.response!==1)return {message:'检查完成，已取消同步'};
        const again=await workflow.inspect(cwd);if(again.branch!==s.branch||again.upstream!==s.upstream||again.advice.action!==s.advice.action)throw Error('仓库状态已改变，请重新检查');
        return {message:await git.action(cwd,s.advice.action)||'同步完成'};
      }
      if(!['branch','remote','upstream','publishBranch'].includes(kind))throw Error('未知 Git 操作');
      const descriptions={branch:`${args.create?'创建并切换':'切换到'}分支 ${args.name}`,remote:`设置远端 ${args.name} → ${args.url}`,upstream:`将当前分支绑定到 ${args.ref}`,publishBranch:`将当前分支发布到 ${args.remote}`};
      const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确认'],defaultId:0,cancelId:0,message:descriptions[kind],detail:cwd});if(answer.response!==1)return {message:'已取消'};
      const result=kind==='branch'?await workflow.branch(cwd,args.name,args.create):kind==='remote'?await workflow.remote(cwd,args.name,args.url):kind==='upstream'?await workflow.upstream(cwd,args.ref):await workflow.publishBranch(cwd,args.remote);
      return {message:result||'仓库设置已更新'};
    }catch(e){throw Error(workflow.friendly(e));}
  });
  register('gitDiff',async(cwd,file,staged)=>require('./git-service.cjs').diff(cwd,file,staged));
  register('gitAction',async(cwd,kind,file,message)=>{
    if(['commit','pull','push'].includes(kind)){const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','执行'],defaultId:0,cancelId:0,message:{commit:'提交已暂存的项目文件？',pull:'仅快进拉取当前分支？',push:'推送当前分支到其上游？'}[kind],detail:cwd+(kind==='commit'?'\n'+message:'')});if(answer.response!==1)return '已取消';}
    return await require('./git-service.cjs').action(cwd,kind,file,message)||'操作完成';
  });
  register('publishCloudProject',async(config,cwd,options)=>{
    if(!path.isAbsolute(cwd)||!options||(!options.files&&!options.conversations))throw Error('请选择要上传的内容');
    if(options.files&&state.projectModes[cwd.toLowerCase()]==='git')throw Error('Git 项目的代码请通过 Git 推送；云端只上传对话');
    const fresh=options.conversations?await core.scan(state.home):{sessions:[],warnings:[]};
    core.requireCompleteScan(fresh,state.home,'停止发布');
    const source=options.conversations?await sourceSelection(cwd,fresh):null;
    const chosen=source?.selected||[];
    let fileLink=state.projectModes[cwd.toLowerCase()]!=='git'?state.directProjects[bindingKey(config,cwd)]:undefined;
    if(state.projectModes[cwd.toLowerCase()]==='git'){const url=(await require('./git-service.cjs').git(cwd,['remote','get-url','origin']).catch(()=>'')).trim();if(url){require('./git-workflow.cjs').validUrl(url);fileLink={kind:'git',url};}}
    if(options.files&&fileLink)throw Error('此项目已关联普通目录，请在项目文件中比较并同步；这里仅上传对话');
    const files=options.files?await require('./project-files.cjs').capture(cwd,{exclude:state.uploadExclusions[cwd.toLowerCase()]||[]}):undefined;
    if(!source&&!files&&!fileLink)throw Error('此项目没有可上传的对话，请选择上传项目文件');
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','上传到云端'],defaultId:0,cancelId:0,message:'确认发布这个项目的所选内容？',detail:cwd+'\n对话：'+chosen.length+' 个；文件：'+(files?.files.length||0)+' 个。完整记录可能含敏感信息。请先结束活动任务。'+(files?'\n文件预览：\n'+files.files.slice(0,30).map(f=>f.path).join('\n'):'\n项目代码仍由 Git 或其他方式管理。')});
    if(answer.response!==1)return {cancelled:true};
    const key=bindingKey(config,cwd),id=state.bindings[key]||core.uuid();
    const published=await core.publishProject(storage(config),chosen,id,source?.profile.name||path.basename(cwd),state.deviceId,files,fileLink,source?.definition);
    state.bindings[key]=id;
    if(files)state.fileBaselines[key]=Object.fromEntries(files.files.map(f=>[f.path,f.hash]));
    if(!state.localProjects.some(p=>p.toLowerCase()===cwd.toLowerCase()))state.localProjects.push(cwd);
    await save();return {id:published.id,conversations:chosen.length,files:files?.files.length||0};
  });
  register('publishFilesOnly',async(config,cwd)=>{
    if(state.projectModes[cwd.toLowerCase()]==='git')throw Error('此项目选择了 Git，请使用 Git 提交和推送，或切换到 WebDAV');
    const files=await require('./project-files.cjs').capture(cwd,{exclude:state.uploadExclusions[cwd.toLowerCase()]||[]});
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','发布项目文件'],defaultId:0,cancelId:0,message:`仅上传 ${files.files.length} 个项目文件，不上传对话`,detail:`${cwd}\n${(files.total/1048576).toFixed(1)} MB；排除 ${files.skipped.length} 项。\n${files.files.slice(0,40).map(f=>f.path).join('\n')}`});if(answer.response!==1)return '已取消';
    const key=bindingKey(config,cwd),id=state.bindings[key]||core.uuid();state.bindings[key]=id;await save();
    await core.publishProject(storage(config),[],id,path.basename(cwd),state.deviceId,files);
    state.fileBaselines[key]=Object.fromEntries(files.files.map(f=>[f.path,f.hash]));await save();return '项目文件已发布；对话未上传';
  });
  if(state.secret&&safeStorage.isEncryptionAvailable()){try{secret=safeStorage.decryptString(Buffer.from(state.secret,'base64'));secretScope=scope(state.storage||{});}catch{secret='';}}
  register('settings',async()=>({...state.storage,hasPassword:!!secret}));
  register('forgetStorage',async()=>{const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','清除本机连接'],defaultId:0,cancelId:0,message:'清除本机保存的云盘连接和密码？',detail:'不会删除云端文件或本机项目。'});if(answer.response!==1)return false;delete state.storage;delete state.secret;secret='';secretScope='';commits=[];plan=[];filePlan=null;await save();return true;});
  register('saveSettings',async config=>{const {password,...plain}=config;storage(config);state.storage=plain;if(password){secret=password;secretScope=scope(config);}else if(secretScope!==scope(config)){secret='';secretScope='';}if(secret&&safeStorage.isEncryptionAvailable())state.secret=safeStorage.encryptString(secret).toString('base64');else delete state.secret;await save();return secret&&!safeStorage.isEncryptionAvailable()?'连接已保存；系统加密不可用，密码仅保留在本次运行':'设置已保存；已加载的密码使用系统加密保存';});
  register('loadEnv',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Environment',extensions:['env','local','*']}]});if(r.canceled)return null;const config=core.readEnv(await fs.readFile(r.filePaths[0],'utf8'));new core.Store(config);secret=config.password;secretScope=scope(config);const {password,...plain}=config;return {...plain,hasPassword:true};});
  register('favorite',async id=>{if(!sessions.some(s=>s.id===id))throw Error('会话不存在');state.favorites[id]=!state.favorites[id];await save();return state.favorites[id];});
  register('exportText',async id=>{const s=sessions.find(s=>s.id===id);if(!s)throw Error('会话不存在');if(s.previewTruncated)throw Error('此对话仅加载了部分预览，请在 Codex 中查看完整内容；未导出截断文本');const r=await dialog.showSaveDialog(win,{defaultPath:`session-${s.id}.md`,filters:[{name:'Markdown',extensions:['md']}]});if(r.canceled)return '已取消';await core.atomic(r.filePath,`# ${s.title}\n\n`+s.messages.map(m=>`## ${m.role}\n\n${m.text}`).join('\n\n'));return '已导出 Markdown';});
  register('scan',async()=>{const result=await core.scan(state.home);sessions=result.sessions;return {home:state.home,warnings:result.warnings,sessions:sessions.map(({raw,file,...s})=>({...s,favorite:!!state.favorites[s.id]})),bindings:state.bindings,localProjects:state.localProjects,conversationProjects:Object.fromEntries(Object.entries(state.conversationProjects).filter(([k])=>JSON.parse(k)[0]===state.home).map(([k,v])=>[JSON.parse(k)[1],v]))};});
  register('choose',async(_kind)=>{filePlan=null;const r=await dialog.showOpenDialog(win,{properties:['openDirectory']});return r.canceled?null:r.filePaths[0];});
  register('home',async p=>{if(typeof p!=='string'||!path.isAbsolute(p))throw Error('目录无效');state.home=p;plan=[];planProject=null;await save();});
  register('test',async config=>{const projects=await core.initializeLibrary(storage(config));await projects.test();return '云盘连接成功，应用同步目录已自动创建';});
  register('publish',async(config,cwd,name,consent,includeFiles=false)=>{
    if(consent!==true)throw Error('请确认完整会话上传授权');
    // Refresh before capture; partial JSONL causes parse failure rather than truncation.
    const fresh=await core.scan(state.home);
    core.requireCompleteScan(fresh,state.home,'停止发布');
    const source=await sourceSelection(cwd,fresh),selected=source.selected;
    let files;
    if(includeFiles&&state.projectModes[cwd.toLowerCase()]==='git')throw Error('Git 项目的文件请通过提交和推送同步');
    if(includeFiles){
      files=await require('./project-files.cjs').capture(cwd,{exclude:state.uploadExclusions[cwd.toLowerCase()]||[]});
      const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','上传这些文件与会话'],defaultId:0,cancelId:0,message:`将额外上传 ${files.files.length} 个项目文件（${(files.total/1048576).toFixed(1)} MB）`,detail:`排除 ${files.skipped.length} 项。排除规则不是凭据扫描，请确认项目内不含其他秘密。\n文件预览（前 40 个）：\n${files.files.slice(0,40).map(f=>f.path).join('\n')}`});
      if(confirm.response!==1)throw Error('已取消项目发布');
    }
    const key=desktopBindingKey(config,cwd),id=state.desktopBindings[key] || core.uuid();state.desktopBindings[key]=id;await save();
    const published=await core.publishProject(storage(config),selected,id,source.profile.name,state.deviceId,files,undefined,source.definition);
    if(files){state.fileBaselines[key]=Object.fromEntries(files.files.map(f=>[f.path,f.hash]));await save();}
    return published;
  });
  register('previewFiles',async(config,id)=>{
    filePlan=null;const commit=commits.find(c=>c.id===id);if(!commit?.fileSnapshot)throw Error('此版本未包含项目文件');
    const cwd=localBinding(config,commit.projectId);if(!cwd)throw Error('请先接入项目并选择本地目录');
    const key=bindingKey(config,cwd);const rows=await require('./project-files.cjs').preview(commit.fileSnapshot,cwd,state.fileBaselines[key]||{});
    filePlan={config,commit,cwd,key};return rows;
  });
  register('applyFiles',async()=>{
    if(!filePlan)throw Error('请先查看项目文件差异');
    const {config,commit,cwd,key}=filePlan;
    if(localBinding(config,commit.projectId)!==cwd)throw Error('项目路径已变化，请重新查看差异');
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','应用文件同步'],defaultId:0,cancelId:0,message:'新增文件将写入，未发生本地修改的文件将更新并备份',detail:`目标：${cwd}\n本地改动保留；冲突版本另存 .sessiondesk-conflict 文件。不会传播删除。请先停止会修改项目文件的任务。`});if(answer.response!==1)return '已取消';
    const result=await require('./project-files.cjs').apply(core.projectStore(storage(config),commit),commit.fileSnapshot,cwd,state.fileBaselines[key]||{},app.getPath('userData'));
    state.fileBaselines[key]=result.baseline;await save();filePlan=null;
    return `文件同步完成，共处理 ${result.results.length} 项。备份与报告：${result.reportPath}`;
  });
  register('detectCodex',async()=>{const found=await require('./codex-cli.cjs').detect(state.codexPath);if(found){state.codexPath=found.path;await save();return `${found.version}\n${found.path}`;}return '未找到 Codex CLI。可以手动选择 codex.exe；会话浏览和云盘上传不受影响。';});
  register('chooseCodex',async()=>{const result=await dialog.showOpenDialog(win,{title:'选择 Codex CLI 可执行文件',properties:['openFile'],filters:[{name:'Codex CLI',extensions:['exe']}]});if(result.canceled)return '已取消';const found=await require('./codex-cli.cjs').check(result.filePaths[0]);state.codexPath=found.path;await save();return `${found.version}\n${found.path}`;});
  register('catalog',async config=>{commits=await core.discoverProjects(storage(config));return commits.map(c=>{const localRef=desktopBinding(config,c.projectId);return {...c,localRef,localPath:profileFor(localRef)?.cwd||null};});});
  register('bind',async(config,id,cwd)=>{if(!commits.some(c=>c.projectId===id)||!path.isAbsolute(cwd))throw Error('项目或目录无效');const key=bindingKey(config,cwd);if(state.bindings[key]&&state.bindings[key]!==id){const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','重新绑定'],defaultId:0,cancelId:0,message:'将此本地目录改绑到另一个云端项目？',detail:cwd+'。不会移动或删除文件，后续恢复目标会改变。'});if(answer.response!==1)return '已取消';delete state.fileBaselines[key];}filePlan=null;plan=[];planProject=null;for(const old of Object.keys(state.bindings)){try{const a=JSON.parse(old);if(old!==key&&bindingKey(config,a[3])===old&&state.bindings[old]===id)delete state.bindings[old];}catch{}}state.bindings[key]=id;await save();return '已接入项目；现在可以查看同步差异';});
  register('download',async(config,id)=>{
    plan=[];planProject=null;const commit=commits.find(c=>c.id===id);if(!commit)throw Error('请刷新云端项目');
    const localRef=desktopBinding(config,commit.projectId),profile=profileFor(localRef),cwd=profile?.cwd;if(!cwd)throw Error('请先关联本机项目');
    if(!profile||profile.mode!=='desktop')throw Error('请先设置本机目录和目标 Codex 项目');
    const home=state.restoreHome||state.home,fresh=await require('./sync-worker.cjs').run('scan',{home},progress);
    core.requireCompleteScan(fresh,home,'停止比较');
    const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请先连接 Codex');const targetInventory=await rpc.inventory(found.path,home);
    const rows=await core.download(core.projectStore(storage(config),commit),commit,fresh.sessions,path.join(app.getPath('userData'),'staging'),progress);
    const definition=commit.definition||model.define(commit.name,rows[0]?.sourceCwd||cwd,[],rows.map(r=>({cwd:r.sourceCwd})));
    const mapping={};for(const root of definition.roots)mapping[root.id]=profile.rootMap?.[model.canonical(root.sourcePath)]||(model.same(root.sourcePath,cwd)?cwd:null);
    plan=model.preview(rows.map(r=>({...r,workspace:r.workspace||model.locate(r.sourceCwd,definition.roots)})),definition,mapping);
    for(const row of plan){row.localName=targetInventory.threads.find(t=>t.id===row.id)?.nativeName||null;row.namePolicy=row.status==='new'?'remote':'local';row.rootMappings=definition.roots.filter(r=>mapping[r.id]).map(r=>({sourcePath:r.sourcePath,targetPath:mapping[r.id]}));const local=fresh.sessions.find(s=>s.id===row.id);if(local){row.localFile=local.file;row.status=await require('./session-io.cjs').compare(local,{file:path.join(app.getPath('userData'),'staging',row.hash+'.jsonl')},row.rootMappings);}if(local&&row.targetCwd&&!model.same(local.cwd,row.targetCwd))row.mappingError='已有对话工作目录不同：'+local.cwd;}
    const settings={home,mode:profile.mode,projectId:profile.targetProjectId||null,name:profile.name,roots:Object.values(mapping).filter(Boolean),syncId:commit.projectId,key:'session-desk-'+core.hash(JSON.stringify([config.type,config.url||config.directory,config.username||'',commit.projectId,home]))};
    planProject={config,id:commit.projectId,commitId:id,localRef,cwd,home,definition,mapping,settings,legacy:!commit.definition};return plan;
  });
  async function requireStopped(){const {stdout}=await promisify(execFile)('tasklist.exe',['/FO','CSV','/NH']);if(/^"(?:ChatGPT|Codex|codex)\.exe"/mi.test(stdout))throw Error('请先完全退出 Codex 桌面端和 CLI，再接收或验证');}
  async function completeRecovery(found){
    if(!lastRecovery.localRef||!desktopState.get(state,lastRecovery.localRef,lastRecovery.sourceHome||state.home))throw Error('恢复记录未能唯一关联到本机项目，请重新接入云端项目并预览；原始备份保持不变');
    try{
      const result=await require('./project-sync.cjs').finish(found.path,lastRecovery,async id=>{lastRecovery.projectSettings.projectId=id;const p=desktopState.get(state,lastRecovery.localRef,lastRecovery.sourceHome||state.home);if(p)p.targetProjectId=id;state.lastRecovery=lastRecovery;await save();},progress);
      lastRecovery.verification=result;state.lastRecovery=lastRecovery;await save();await core.atomic(lastRecovery.reportPath,JSON.stringify(lastRecovery,null,2));await core.atomic(path.join(path.dirname(lastRecovery.reportPath),'discovery.json'),JSON.stringify(result,null,2));
      const p=desktopState.get(state,lastRecovery.localRef,lastRecovery.sourceHome||state.home);if(p&&model.same(lastRecovery.home,lastRecovery.sourceHome||state.home)){p.threadIds=[...new Set([...p.threadIds,...result.results.filter(r=>r.readable&&r.pathMatches&&r.membership).map(r=>r.id)])];if(result.complete&&result.projectId){p.sourceProjectId=result.projectId;p.targetProjectId=result.projectId;const ref='codex:'+result.projectId,old=lastRecovery.localRef,home=lastRecovery.sourceHome||state.home;state.desktopProjects[desktopState.key(home,ref)]=p;if(old!==ref){delete state.desktopProjects[desktopState.key(home,old)];for(const k of Object.keys(state.desktopBindings)){const a=JSON.parse(k);if(a[3]===model.canonical(home)&&a[4]===old){a[4]=ref;state.desktopBindings[JSON.stringify(a)]=state.desktopBindings[k];delete state.desktopBindings[k];}}lastRecovery.localRef=ref;}}await save();}
      return (result.complete?'内容、目录'+(result.mode==='desktop'?'及原生项目归属均已验证':'已验证（CLI 模式，不修改项目归属）'):'内容已恢复，部分目录或归属验证未完成，请查看结果并重试')+'。备份：'+lastRecovery.reportPath;
    }catch(e){lastRecovery.verification={complete:false,error:e.message};state.lastRecovery=lastRecovery;await save();return '内容已恢复，原生识别或归属仍待完成：'+e.message+'。可点击重试验证；备份：'+lastRecovery.reportPath;}
  }
  register('restore',async()=>{
    if(!planProject)throw Error('请先查看对话差异');if(plan.some(r=>r.status==='conflict'&&!['keep-both','skip'].includes(r.conflictPolicy)))throw Error('请为每条冲突对话选择保留分叉或跳过');
    if(plan.some(r=>r.mappingError)||Object.values(planProject.mapping).some(p=>!p))throw Error('仍有未完成的目录映射，请逐项选择本机目录并重新比较');
    if(desktopBinding(planProject.config,planProject.id)!==planProject.localRef)throw Error('项目绑定已变化，请重新比较');
    for(const p of [...new Set([...planProject.settings.roots,...plan.map(r=>r.targetCwd)])])if(!(await fs.stat(p).catch(()=>null))?.isDirectory())throw Error('工作目录不存在，请先准备项目文件：'+p);
    const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('未找到 Codex CLI，无法完成原生恢复；请先到设置安装或选择');
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','按预览接收'],defaultId:0,cancelId:0,checkboxLabel:'自动关闭 Codex 桌面端，接收结束后重新打开（请先结束活动任务）',checkboxChecked:false,message:'按逐条选择的方案接收对话？',detail:'目标数据目录：'+planProject.home+'\n本地目录：'+planProject.cwd+'\n不传输项目文件。写入前备份；未选择自动关闭时，请自行退出 Codex。不会强制结束 CLI 或活动进程。'});if(!answer.response)return '已取消';
    return require('./codex-lifecycle.cjs').manage(answer.checkboxChecked,async()=>{
    await requireStopped();
    await rpc.withClient(found.path,planProject.home,request=>require('./project-sync.cjs').preflight(request,planProject.settings,plan.filter(r=>r.status!=='conflict')));
    const result=await require('./sync-worker.cjs').run('receive',{rows:plan,cache:path.join(app.getPath('userData'),'staging'),home:planProject.home,cwd:planProject.cwd,options:{perRow:true}},progress);
    const byId=new Map(plan.map(r=>[r.id,r])),byBranch=new Map(plan.map(r=>[require('./recovery.cjs').branchId(r.id,r.hash),r])),sourceRow=r=>byId.get(r.sourceId||r.id)||byBranch.get(r.id);
    const expectedNames={};for(const r of result.results){const row=sourceRow(r);if(row?.remoteName&&(row.namePolicy==='remote'||r.sourceId||r.id!==row.id)&&r.status!=='conflict')expectedNames[r.id]=row.remoteName;}
    lastRecovery={...result,expectedNames,expectedTitles:Object.fromEntries(result.results.map(r=>[r.id,sourceRow(r)?.title||r.id])),localRef:planProject.localRef,cwd:planProject.cwd,sourceHome:state.home,expectedDirectories:Object.fromEntries(result.results.map(r=>[r.id,sourceRow(r)?.targetCwd])),projectSettings:planProject.settings};state.lastRecovery=lastRecovery;await save();await core.atomic(lastRecovery.reportPath,JSON.stringify(lastRecovery,null,2));plan=[];planProject=null;
    return completeRecovery(found);
    },{onProgress:progress});
  });
  register('cache',async()=>{const p=path.join(app.getPath('userData'),'staging');await fs.mkdir(p,{recursive:true});await shell.openPath(p);});
  register('recoveryStatus',async()=>lastRecovery?{home:lastRecovery.home,cwd:lastRecovery.cwd,reportPath:lastRecovery.reportPath,verification:lastRecovery.verification,results:lastRecovery.results,expectedTitles:lastRecovery.expectedTitles}:null);
  register('verifyRecovery',async()=>{if(!lastRecovery?.projectSettings)throw Error('旧恢复记录没有项目映射，请重新比较并接收');const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','重试验证'],defaultId:0,cancelId:0,checkboxLabel:'自动关闭 Codex 桌面端，验证后重新打开',checkboxChecked:false,message:'重新验证已接收的对话？',detail:'不会重复导入或覆盖对话。请先结束活动任务。'});if(!answer.response)return '已取消';return require('./codex-lifecycle.cjs').manage(answer.checkboxChecked,async()=>{await requireStopped();const found=await require('./codex-cli.cjs').detect(state.codexPath);if(!found)throw Error('请到设置选择 Codex CLI');return completeRecovery(found);},{onProgress:progress});});
  win=new BrowserWindow({width:1440,height:940,minWidth:1100,minHeight:760,backgroundColor:'#f6f7f9',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  await win.loadFile('desktop.html');
});
app.on('window-all-closed',()=>app.quit());
