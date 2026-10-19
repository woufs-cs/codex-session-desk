const sourceKinds=['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
const {spawn}=require('node:child_process');
const io=require('./session-io.cjs');
// No inference requests are made by this client. Mutations use native metadata APIs.
async function connect(executable,home){
  const child=spawn(executable,['app-server','--stdio'],{env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let sequence=0,closed=false;const pending=new Map();
  const fail=e=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
  child.on('error',()=>fail(Error('无法启动 Codex CLI')));child.on('exit',()=>fail(Error('Codex 接口进程已退出')));child.stderr.resume();child.stdin.on('error',()=>fail(Error('Codex 连接已关闭')));
  (async()=>{for await(const line of io.lines(child.stdout)){let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(!p)continue;pending.delete(m.id);clearTimeout(p.timer);if(m.error){const e=Error(`${p.method}: ${m.error.message||'接口失败'}`);e.code=m.error.code;p.reject(e);}else p.resolve(m.result);}})().catch(()=>{fail(Error('Codex 接口返回内容超过安全限制或读取中断；已停止验证，请保留恢复报告'));child.kill();});
  const request=(method,params={})=>new Promise((resolve,reject)=>{if(closed)return reject(Error('Codex 连接已关闭'));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' 超时'));},30000);pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){pending.delete(id);clearTimeout(timer);reject(e);}});});
  const close=()=>{child.stdout.destroy();child.stdin.end();child.kill();fail(Error('连接已结束'));};
  try{await request('initialize',{clientInfo:{name:'session_desk',version:'0.15.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');return {request,close};}catch(e){close();throw e;}
}
async function withClient(executable,home,fn){const client=await connect(executable,home);try{return await fn(client.request);}finally{client.close();}}
async function pages(request,method,params={}){const result=[],seen=new Set();let cursor;do{const p=await request(method,{...(method==='thread/list'?{sourceKinds}:{}),...params,limit:100,...(cursor?{cursor}:{})});result.push(...p.data);cursor=p.nextCursor;if(cursor&&seen.has(cursor))throw Error('Codex 分页游标重复');seen.add(cursor);}while(cursor);return result;}
async function listThreads(request){const threads=[];for(const archived of [false,true])for(const t of await pages(request,'thread/list',{archived,useStateDbOnly:true}))threads.push({id:t.id,projectId:t.projectId,cwd:t.cwd,nativeName:t.name||null,title:t.name||t.preview,source:t.source,archived});return threads;}
async function nativeInventory(executable,home){return withClient(executable,home,async request=>({projects:await pages(request,'project/list'),threads:await listThreads(request)}));}
async function inventory(executable,home){return require('./desktop-membership.cjs').enrich(await nativeInventory(executable,home),home);}
module.exports={connect,withClient,pages,inventory,listThreads};
