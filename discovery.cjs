const {spawn}=require('node:child_process');
const readline=require('node:readline');
// No turns are started; the Codex runtime only reads the imported thread IDs.
async function verify(executable,home,ids,{resume=false}={}){
  const child=spawn(executable,['app-server','--stdio'],{env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let counter=0;const pending=new Map();
  const stop=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',()=>stop(Error('无法启动选定的 Codex 程序')));
  child.on('exit',()=>stop(Error('Codex 验证进程已退出')));
  child.stderr.resume();
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('Codex 无法读取该会话')):p.resolve(m.result);}}catch{}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++counter;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Codex 验证超时'));},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){clearTimeout(timer);pending.delete(id);reject(Error('Codex 连接已关闭'));}});});
  try{
    await request('initialize',{clientInfo:{name:'session_desk',version:'0.4.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const results=[];
    const local=await require('./core.cjs').scan(home);
    for(const id of ids){try{
      const expected=local.sessions.find(s=>s.id===id)?.cwd;
      if(resume)await request('thread/resume',{threadId:id,cwd:expected,approvalPolicy:'untrusted',sandbox:'read-only'});
      const result=await request('thread/read',{threadId:id,includeTurns:true});
      let turns=result.thread?.turns?.length||0;
      if(!turns){try{const page=await request('thread/turns/list',{threadId:id,limit:100,itemsView:'summary'});turns=page.data?.length||0;}catch{}}
      results.push({id,readable:result.thread?.id===id,turns,cwd:result.thread?.cwd,pathMatches:!!expected&&expected.toLowerCase()===result.thread?.cwd?.toLowerCase()});
    }catch(e){results.push({id,readable:false,error:e.message});}}
    return results;
  }finally{lines.close();child.stdin.end();child.kill();stop(Error('验证已结束'));}
}
module.exports={verify};
