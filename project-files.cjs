const fs=require('node:fs/promises'),path=require('node:path'),c=require('./core.cjs');
const excluded=new Set(['.git','node_modules','.venv','venv','__pycache__','.next','dist','build','.cache','.codex','.ssh','session-desk-backups']);
const maxFile=20*1024*1024,maxTotal=200*1024*1024;
function allowed(name){const n=name.toLowerCase();return !excluded.has(n)&&!n.startsWith('.env')&&!/^(auth|credentials|secrets)\.(json|toml|ya?ml)$/.test(n)&&! /\.(pem|key|pfx|p12)$/.test(n)&&!n.includes('.sessiondesk-conflict-');}
function validRelative(p){return typeof p==='string'&&p.length<220&&!p.includes('\\')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!/[<>:"|?*\x00-\x1f]/.test(s)&&!/[. ]$/.test(s)&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)&&allowed(s));}
async function safe(p){for(let v=path.resolve(p);;v=path.dirname(v)){try{if((await fs.lstat(v)).isSymbolicLink())throw Error('不能同步链接或联接目录');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(v)===v)break;}}
function exclusions(values=[]){
  if(!Array.isArray(values)||values.length>200)throw Error('最多设置 200 条排除路径');
  return [...new Set(values.map(v=>String(v).trim().replace(/\\/g,'/').replace(/\/$/,'')).filter(Boolean))].map(v=>{if(v.startsWith('/')||v.split('/').some(p=>!p||p==='.'||p==='..')||/[:*?\x00-\x1f]/.test(v))throw Error('排除项应为相对文件或目录路径，不支持通配符');return v;});
}
async function capture(root,{exclude=[]}={}){
  const custom=exclusions(exclude).map(v=>v.toLowerCase());
  if(!path.isAbsolute(root))throw Error('请选择绝对路径');await safe(root);
  const files=[],skipped=[];let total=0;
  async function visit(dir,rel=''){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const name=rel?rel+'/'+entry.name:entry.name,full=path.join(dir,entry.name);
      if(!allowed(entry.name)||entry.isSymbolicLink()||custom.some(v=>name.toLowerCase()===v||name.toLowerCase().startsWith(v+'/'))){skipped.push(name);continue;}
      if(!validRelative(name))throw Error('不支持的项目文件路径：'+name);
      if(entry.isDirectory()){await safe(full);await visit(full,name);}else if(entry.isFile()){
        await safe(full);if(files.length>=5000)throw Error('项目文件超过 5000 个');
        if((await fs.stat(full)).size>maxFile)throw Error('单文件超过 20 MB：'+name);
        const data=await fs.readFile(full);total+=data.length;
        if(data.length>maxFile||total>maxTotal)throw Error('项目快照超过大小限制');
        files.push({path:name,hash:c.hash(data),size:data.length,data});
      }
    }
  }
  await visit(root);return {files,skipped,total};
}
async function upload(store,snapshot){
  for(const file of snapshot.files){const key='file-'+file.hash+'.b64';await store.put(key,file.data.toString('base64'));if(c.hash(Buffer.from(await store.get(key),'base64'))!==file.hash)throw Error('项目文件上传校验失败');}
  return {version:1,files:snapshot.files.map(({data,...meta})=>meta),total:snapshot.total};
}
function validate(manifest){
  if(manifest?.version!==1||!Array.isArray(manifest.files)||manifest.files.length>5000)throw Error('项目文件清单无效');
  const names=new Set();let total=0;
  for(const f of manifest.files){if(!validRelative(f.path)||! /^[a-f0-9]{64}$/.test(f.hash)||!Number.isInteger(f.size)||f.size<0||f.size>maxFile)throw Error('不安全的项目文件清单');const key=f.path.toLowerCase();if(names.has(key))throw Error('文件路径重复');names.add(key);total+=f.size;}
  if(total>maxTotal)throw Error('项目文件总量过大');
}
async function localHash(file){await safe(file);try{const st=await fs.stat(file);if(!st.isFile())throw Error('目标路径不是文件');if(st.size>maxFile)throw Error('目标文件过大，停止同步');return c.hash(await fs.readFile(file));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function preview(manifest,root,baseline={}){
  validate(manifest);if(!path.isAbsolute(root))throw Error('目标目录无效');await safe(root);const rows=[];
  for(const f of manifest.files){const current=await localHash(path.join(root,f.path)),base=baseline[f.path];
    const status=current===f.hash?'identical':current===null?'new':base===current?'update':base===f.hash?'local-ahead':'conflict';rows.push({...f,current,status});}
  return rows;
}
async function apply(store,manifest,root,baseline,stateDir){
  const rows=await preview(manifest,root,baseline),batch=path.join(stateDir,'file-backups',c.uuid());await fs.mkdir(batch,{recursive:true});
  const next={...baseline},results=[];const staged=new Map();
  // Verify every download before touching project files.
  for(const row of rows.filter(r=>['new','update','conflict'].includes(r.status))){const bytes=Buffer.from(await store.get('file-'+row.hash+'.b64'),'base64');if(bytes.length!==row.size||c.hash(bytes)!==row.hash)throw Error('项目文件下载校验失败');staged.set(row.path,bytes);}
  try{
    for(const [index,row]of rows.entries()){
      const original=path.join(root,row.path);if(await localHash(original)!==row.current)throw Error('文件已变化，请重新查看差异：'+row.path);
      if(row.status==='local-ahead'){results.push({path:row.path,status:'local-ahead'});continue;}
      if(row.status==='identical'){next[row.path]=row.hash;results.push({path:row.path,status:'identical'});continue;}
      const target=row.status==='conflict'?original+'.sessiondesk-conflict-'+row.hash.slice(0,12):original;await safe(target);
      if(row.status==='conflict'&&await localHash(target)===row.hash){results.push({path:row.path,status:'conflict-preserved'});continue;}
      await fs.mkdir(path.dirname(target),{recursive:true});
      if(row.status==='update'){
        await fs.copyFile(target,path.join(batch,index+'.bin'),fs.constants.COPYFILE_EXCL);
        if(await localHash(target)!==row.current)throw Error('目标文件在备份期间变化');
        await c.atomic(target,staged.get(row.path));
      }else{
        const temp=target+'.'+c.uuid()+'.tmp';try{await fs.writeFile(temp,staged.get(row.path),{flag:'wx'});await fs.link(temp,target);}finally{await fs.rm(temp,{force:true});}
      }
      if(row.status!=='conflict')next[row.path]=row.hash;
      results.push({path:row.path,target,status:row.status,backup:row.status==='update'?index+'.bin':null});
      await c.atomic(path.join(batch,'report.json'),JSON.stringify({state:'applying',results},null,2));
    }
    await c.atomic(path.join(batch,'report.json'),JSON.stringify({state:'complete',results},null,2));
    return {baseline:next,results,reportPath:path.join(batch,'report.json')};
  }catch(e){await c.atomic(path.join(batch,'report.json'),JSON.stringify({state:'partial',error:e.message,results},null,2));throw Error(e.message+'；部分文件可能已完成，报告：'+path.join(batch,'report.json'));}
}
module.exports={capture,upload,preview,apply,validate,allowed,exclusions};
