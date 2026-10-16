const {canonical}=require('./project-model.cjs');
const key=(home,ref)=>JSON.stringify([canonical(home),ref]);
const bindingKey=(config,home,ref)=>JSON.stringify([config.type,config.type==='webdav'?config.url:config.directory,config.username||'',canonical(home),ref]);
const get=(state,ref,home=state.home)=>state.desktopProjects[key(home,ref)];
function find(state,config,id){return Object.keys(state.desktopBindings).map(k=>{const a=JSON.parse(k);return bindingKey(config,state.home,a[4])===k&&state.desktopBindings[k]===id?a[4]:null;}).find(Boolean);}
function migrate(state){
 state.desktopProjects||={};state.desktopBindings||={};
 if(state.desktopIdentityVersion===1)return;
 for(const [oldKey,p]of Object.entries(state.conversationProjects||{})){
  if(p.mode!=='desktop')continue;
  const [home,cwd]=JSON.parse(oldKey),ref=p.sourceProjectId?'codex:'+p.sourceProjectId:'pending:'+require('./core.cjs').hash(oldKey).slice(0,20);
  state.desktopProjects[key(home,ref)]||={...p,cwd:p.roots?.[0]||cwd};
  for(const [bk,id]of Object.entries(state.bindings||{})){
   const [type,location,username,bound]=JSON.parse(bk);
   if(canonical(bound)!==canonical(cwd))continue;
   const config={type,username,url:location,directory:location};
   state.desktopBindings[bindingKey(config,home,ref)]||=id;
  }
 }
 const report=state.lastRecovery;
 if(report&&!report.localRef){const home=report.sourceHome||state.home,candidates=Object.entries(state.desktopProjects).filter(([k,p])=>JSON.parse(k)[0]===canonical(home)&&canonical(p.cwd)===canonical(report.cwd)&&(!report.projectSettings?.projectId||p.targetProjectId===report.projectSettings.projectId));if(candidates.length===1)report.localRef=JSON.parse(candidates[0][0])[1];}
 state.desktopIdentityVersion=1;
}
module.exports={key,bindingKey,get,find,migrate};
