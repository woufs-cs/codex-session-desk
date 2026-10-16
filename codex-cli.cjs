const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
async function check(executable){
  if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!=='codex.exe')throw Error('请选择 Codex CLI 的 codex.exe');
  const {stdout}=await promisify(execFile)(executable,['--version'],{timeout:8000,windowsHide:true});
  if(!/^codex-cli\s+[\w.-]+/i.test(stdout.trim()))throw Error('所选程序不是可识别的 Codex CLI');
  return {path:executable,version:stdout.trim()};
}
async function detect(saved){
  const roots=[...(process.env.PATH||'').split(path.delimiter),path.join(process.env.APPDATA||os.homedir(),'npm'),'D:\\Tools\\npm-global'];
  const candidates=[saved];
  for(const root of roots.filter(Boolean)){
    candidates.push(path.join(root,'codex.exe'));
    const pkg=path.join(root,'node_modules','@openai');
    for(const platform of ['codex-win32-x64','codex-win32-arm64'])for(const base of [pkg,path.join(pkg,'codex','node_modules','@openai')])for(const arch of ['x86_64','aarch64'])candidates.push(path.join(base,platform,'vendor',arch+'-pc-windows-msvc','bin','codex.exe'));
  }
  for(const file of [...new Set(candidates.filter(Boolean))]){try{await fs.access(file);return await check(file);}catch{}}
  return null;
}
module.exports={check,detect};
