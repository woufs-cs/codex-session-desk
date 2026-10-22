const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
async function check(executable){
  const expected=process.platform==='win32'?'codex.exe':'codex';
  if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!==expected)throw Error(`请选择 Codex CLI 的 ${expected}`);
  if(process.platform==='darwin'){
    const real=await fs.realpath(executable);
    if(real.endsWith('/bin/codex.js')){
      const pkg=path.dirname(path.dirname(real)),arch=process.arch==='arm64'?'aarch64':'x86_64',platform=process.arch==='arm64'?'arm64':'x64';
      const candidates=[path.join(pkg,'node_modules','@openai','codex-darwin-'+platform,'vendor',arch+'-apple-darwin','bin','codex'),path.join(path.dirname(pkg),'codex-darwin-'+platform,'vendor',arch+'-apple-darwin','bin','codex'),path.join(pkg,'vendor',arch+'-apple-darwin','bin','codex')];
      executable=await (async()=>{for(const p of candidates)if(await fs.access(p).then(()=>true,()=>false))return p;throw Error('找到 npm 启动脚本，但未找到原生 Codex 程序；请重新安装 Codex CLI');})();
    }else executable=real;
  }
  const {stdout}=await promisify(execFile)(executable,['--version'],{timeout:8000,windowsHide:true});
  if(!/^codex-cli\s+[\w.-]+/i.test(stdout.trim()))throw Error('所选程序不是可识别的 Codex CLI');
  return {path:executable,version:stdout.trim()};
}
async function detect(saved){
  const roots=[...(process.env.PATH||'').split(path.delimiter),path.join(process.env.APPDATA||os.homedir(),'npm'),path.join(os.homedir(),'.npm-global','bin'),'D:\\Tools\\npm-global'];
  const candidates=[saved];
  if(process.platform!=='win32')candidates.push('/opt/homebrew/bin/codex','/usr/local/bin/codex',path.join(os.homedir(),'.local','bin','codex'));
  for(const root of roots.filter(Boolean)){
    candidates.push(path.join(root,process.platform==='win32'?'codex.exe':'codex'));
    const pkg=path.join(root,'node_modules','@openai');
    const platforms=process.platform==='darwin'?(process.arch==='arm64'?['codex-darwin-arm64','codex-darwin-x64']:['codex-darwin-x64','codex-darwin-arm64']):['codex-win32-x64','codex-win32-arm64'];
    const archDirs=process.platform==='darwin'?(process.arch==='arm64'?['aarch64-apple-darwin','x86_64-apple-darwin']:['x86_64-apple-darwin','aarch64-apple-darwin']):['x86_64-pc-windows-msvc','aarch64-pc-windows-msvc'];
    for(const platform of platforms)for(const base of [pkg,path.join(root,'node_modules','@openai','codex','node_modules','@openai')])for(const arch of archDirs)candidates.push(path.join(base,platform,'vendor',arch,'bin',process.platform==='win32'?'codex.exe':'codex'));
  }
  for(const file of [...new Set(candidates.filter(Boolean))]){try{await fs.access(file);return await check(file);}catch{}}
  return null;
}
module.exports={check,detect};
