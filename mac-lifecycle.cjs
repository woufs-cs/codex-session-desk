const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile);
function parseProcesses(text){
 const all=[];
 for(const line of text.split('\n')){
  const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);if(!m)continue;
  const executable=m[4].trim(),bundle=executable.match(/^(.*\/(?:Codex|ChatGPT)\.app)\/Contents\//);
  all.push({ProcessId:+m[1],ParentProcessId:+m[2],CreationDate:m[3],ExecutablePath:executable,BundlePath:bundle?.[1],CommandLine:''});
 }
 const ids=new Set(all.filter(r=>r.BundlePath||/(?:^|\/)codex(?:-aarch64-apple-darwin|-x86_64-apple-darwin)?$/.test(r.ExecutablePath)).map(r=>r.ProcessId));
 let added;do{added=false;for(const r of all)if(ids.has(r.ParentProcessId)&&!ids.has(r.ProcessId)){ids.add(r.ProcessId);added=true;}}while(added);
 return all.filter(r=>ids.has(r.ProcessId));
}
async function list(){const {stdout}=await exec('/bin/ps',['-ww','-axo','pid=,ppid=,lstart=,comm='],{env:{...process.env,LC_ALL:'C'},timeout:10000,maxBuffer:8*1024*1024});return parseProcesses(stdout);}
async function desktopApps(rows){return rows.filter(r=>r.BundlePath&&/^\/(?:.*\/)?(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(r.ExecutablePath)).map(r=>({pid:r.ProcessId,path:r.BundlePath}));}
async function close(app){
 if(!/^\/.*\/(?:Codex|ChatGPT)\.app$/.test(app.path))throw Error('无法确认 Codex 应用路径');
 // Argument passing avoids injecting a path into AppleScript source.
 await exec('/usr/bin/osascript',['-e','on run argv','-e','tell application (item 1 of argv) to quit','-e','end run',app.path],{timeout:15000});
}
async function restart(app){await exec('/usr/bin/open',['-a',app.path],{timeout:15000});}
// No force termination on macOS in the first preview. Remaining tasks block writes.
module.exports={list,desktopApps,close,restart,parseProcesses};
