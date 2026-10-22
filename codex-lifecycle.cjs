const {execFile,spawn}=require('node:child_process'),{promisify}=require('node:util'),fs=require('node:fs/promises'),path=require('node:path');
const exec=promisify(execFile);
async function powershell(script){return (await exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';\n"+script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout;}
async function list(){
 const data=await powershell("@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Codex|ChatGPT)\\.exe$' } | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}},ExecutablePath,CommandLine) | ConvertTo-Json -Compress");
 const rows=JSON.parse(data.trim()||'[]');return Array.isArray(rows)?rows:[rows];
}
async function desktopApps(rows){
 const apps=[];for(const row of rows){if(!row.ExecutablePath||/--type=/.test(row.CommandLine||''))continue;
  // Electron desktop executable only: never close the CLI or an app-server.
  if(await fs.access(path.join(path.dirname(row.ExecutablePath),'chrome_elf.dll')).then(()=>true,()=>false))apps.push({pid:row.ProcessId,path:row.ExecutablePath});
 }return apps;
}
async function close(app){
 if(!Number.isInteger(app.pid))throw Error('无效进程');
 await powershell(`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class DeskClose {public delegate bool C(IntPtr h,IntPtr p);[DllImport("user32.dll")]public static extern bool EnumWindows(C c,IntPtr p);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);public static void Send(uint target){EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==target)PostMessage(h,16,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);}}
'@
[DeskClose]::Send(${app.pid})`);
}
async function restart(app){await new Promise((resolve,reject)=>{const p=spawn(app.path,[],{detached:true,stdio:'ignore',windowsHide:false});p.once('error',reject);p.once('spawn',()=>{p.unref();resolve();});});}
function ownedProcesses(rows,apps,before=rows){
 const ids=new Set(before.filter(r=>apps.some(a=>a.pid===r.ProcessId)).map(r=>r.ProcessId));
 let changed;do{changed=false;for(const r of [...before,...rows])if(ids.has(r.ParentProcessId)&&!ids.has(r.ProcessId)){ids.add(r.ProcessId);changed=true;}}while(changed);
 return rows.filter(r=>r.ExecutablePath&&r.CreationDate&&!before.some(b=>b.ProcessId===r.ProcessId&&b.CreationDate&&b.CreationDate!==r.CreationDate)&&(ids.has(r.ProcessId)||apps.some(a=>a.path.toLowerCase()===r.ExecutablePath.toLowerCase()&&/--type=/.test(r.CommandLine||''))));
}
async function force(rows){
 const encoded=Buffer.from(JSON.stringify(rows.map(r=>({id:r.ProcessId,path:r.ExecutablePath,created:r.CreationDate})))).toString('base64');
 await powershell(`$targets=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
foreach($target in $targets){$p=Get-CimInstance Win32_Process -Filter ("ProcessId = "+[int]$target.id);if($p -and $p.ExecutablePath -eq $target.path -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq [string]$target.created){Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop}}`);
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const platformAdapters=process.platform==='darwin'?{...require('./mac-lifecycle.cjs'),sleep}:{list,desktopApps,close,restart,sleep,force};
async function manage(enabled,action,{onProgress=()=>{},confirmForce=async()=>false,adapter=platformAdapters,timeout=8000}={}){
 const closed=[];let value,error;try{
  const before=await adapter.list();
  if(enabled){const apps=await adapter.desktopApps(before);for(const app of apps){onProgress({stage:'关闭 Codex',detail:'等待桌面端正常退出；不会强制结束活动任务'});closed.push(app);await adapter.close(app);}
   const deadline=Date.now()+timeout;while((await adapter.list()).length&&Date.now()<deadline)await adapter.sleep(500);
   const remaining=await adapter.list(),owned=ownedProcesses(remaining,apps,before);
   if(owned.length&&adapter.force&&await confirmForce(owned)){onProgress({stage:'结束残留桌面进程',detail:'只处理已识别的桌面端进程；随后检查是否完全退出'});await adapter.force(owned);const until=Date.now()+5000;while((await adapter.list()).length&&Date.now()<until)await adapter.sleep(500);}
  }
  const blockers=await adapter.list();if(blockers.length)throw Error('Codex 尚未完全退出。本次未写入，请结束任务后重试。残留进程：'+blockers.map(r=>`${r.ProcessId} (${r.ExecutablePath||'路径不可读'})`).join('、'));
  value=await action();
 }catch(e){error=e;}finally{
  const remaining=await adapter.list().catch(()=>null);
  for(const app of new Map(closed.map(a=>[a.path.toLowerCase(),a])).values()){if(!remaining||remaining.some(r=>r.ExecutablePath===app.path||r.BundlePath===app.path))continue;try{onProgress({stage:'重新打开 Codex',detail:'接收处理已结束'});await adapter.restart(app);}catch(e){const note='Codex 自动重启失败，请手动打开：'+e.message;if(error)error.message+='；'+note;else value=String(value||'')+'；'+note;}}
 }
 if(error)throw error;return value;
}
async function requireStopped(){if((await platformAdapters.list()).length)throw Error('请先完全退出 Codex 桌面端和 CLI，再接收或验证');}
module.exports={manage,desktopApps,ownedProcesses,requireStopped};
