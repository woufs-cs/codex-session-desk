const fs=require('node:fs/promises'),path=require('node:path'),core=require('./core.cjs'),files=require('./project-files.cjs');
const max=20*1024*1024;
function endpoint(value,service){const u=new URL(value),s=new URL(service);if(u.protocol!=='https:'||u.origin!==s.origin||u.username||u.password||u.search||u.hash)throw Error('项目目录必须是当前 WebDAV 服务同一站点的 HTTPS 地址，不能包含账号、查询参数');u.pathname=u.pathname.replace(/\/+$/,'')+'/';if((s.pathname.replace(/\/+$/,'')+'/').startsWith(u.pathname))throw Error('项目目录不能包含应用同步库，请选择独立子目录或同级目录');if(u.pathname==='/'||/\/SessionDesk(?:\/|$)/i.test(decodeURIComponent(u.pathname)))throw Error('请选择专用项目目录，不能使用站点根目录或应用元数据目录');return u.href;}
const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|[0-9]+);/gi,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x]??String.fromCodePoint(parseInt(x.slice(2,-1).replace(/^x/i,''),/^&#x/i.test(x)?16:10))));
function tag(xml,name){return xml.match(new RegExp('<(?:[\\w-]+:)?'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?'+name+'>','i'))?.[1];}
function listing(xml,base){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<(?:[\w-]+:)?multistatus\b/i.test(xml))throw Error('WebDAV 返回无效目录 XML');
  const result=[],seen=new Set(),basePath=decodeURIComponent(new URL(base).pathname).replace(/\/$/,'');let self=false;
  for(const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)){
    const href=tag(m[1],'href');if(!href)throw Error('目录项缺少地址');const u=new URL(decode(href.trim()),base);
    if(u.origin!==new URL(base).origin||u.search||u.hash)throw Error('目录返回跨站地址');
    if(/%2f|%5c/i.test(u.pathname))throw Error('目录地址包含编码分隔符');
    const decoded=decodeURIComponent(u.pathname).replace(/\/$/,'');
    const props=[...m[1].matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)].filter(x=>/\s200\b/.test(tag(x[1],'status')||'')).map(x=>tag(x[1],'prop')||'').join('');
    if(!props)throw Error('无法读取目录项属性');const directory=/<(?:[\w-]+:)?collection\b/i.test(props);
    if(decoded===basePath){if(!directory)throw Error('所选地址不是目录');self=true;continue;}
    if(!decoded.startsWith(basePath+'/'))throw Error('目录项越界');const name=decoded.slice(basePath.length+1);
    if(name.includes('/')||!name)throw Error('服务返回非直接子项');
    const key=name.toLowerCase();if(seen.has(key))throw Error('云端存在大小写冲突路径');seen.add(key);
    result.push({name,directory});
  }
  if(!self)throw Error('无法确认 WebDAV 目录本身');return result;
}
async function bytes(response,limit){const chunks=[];let count=0;for await(const chunk of response.body){count+=chunk.length;if(count>limit)throw Error('远端文件超过大小限制');chunks.push(chunk);}return Buffer.concat(chunks);}
class Directory {
  constructor(config,url){this.url=endpoint(url,config.url);this.config=config;}
  address(rel=''){return this.url+rel.split('/').map(encodeURIComponent).join('/');}
  async request(rel,method='GET',body,extra={}){const r=await fetch(this.address(rel),{method,body,headers:{Authorization:'Basic '+Buffer.from((this.config.username||'')+':'+(this.config.password||'')).toString('base64'),...extra},redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok){const e=Error('WebDAV '+method+' HTTP '+r.status);e.status=r.status;throw e;}return r;}
  async list(rel=''){const r=await this.request(rel,'PROPFIND','<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',{Depth:'1','Content-Type':'application/xml'});return listing((await bytes(r,4*1024*1024)).toString('utf8'),this.address(rel));}
  async get(rel){const r=await this.request(rel);return {data:await bytes(r,max),etag:r.headers.get('etag')};}
  async create(){// New means new: never quietly reuse an existing directory.
    try{await this.list();throw Error('该云端目录已存在，请改选关联已有目录');}catch(e){if(e.status!==404)throw e;}
    await this.request('','MKCOL');await this.list();
  }
  async parents(rel){const parts=rel.split('/');parts.pop();let dir='';for(const part of parts){dir+=part+'/';try{await this.request(dir,'MKCOL');}catch(e){if(e.status!==405)throw e;await this.list(dir);}}}
  async put(rel,data,etag){if(etag!==null&&(!etag||/^W\//i.test(etag)))throw Error('服务没有提供强 ETag，不能安全更新现有文件');await this.parents(rel);await this.request(rel,'PUT',data,etag===null?{'If-None-Match':'*'}:{'If-Match':etag});}
  async capture(exclude=[]){const custom=files.exclusions(exclude).map(x=>x.toLowerCase()),out=[];let total=0,dirs=0;
    const walk=async(rel='')=>{if(++dirs>1000||rel.split('/').length>40)throw Error('云端目录层级或数量过多');for(const entry of await this.list(rel)){
      const name=rel+entry.name;if(!files.allowed(entry.name)||custom.some(x=>name.toLowerCase()===x||name.toLowerCase().startsWith(x+'/')))continue;
      files.validate({version:1,files:[{path:name,hash:'0'.repeat(64),size:0}]});
      if(entry.directory)await walk(name+'/');else{const value=await this.get(name);total+=value.data.length;if(total>200*1024*1024||out.length>=5000)throw Error('项目超过 200 MB 或 5000 文件限制');out.push({path:name,hash:core.hash(value.data),size:value.data.length,...value});}
    }};await walk();return {files:out,total};
  }
}
function compare(local,remote,base={}){const l=new Map(local.files.map(x=>[x.path.toLowerCase(),x])),r=new Map(remote.files.map(x=>[x.path.toLowerCase(),x]));if(l.size!==local.files.length||r.size!==remote.files.length)throw Error('文件路径大小写冲突');const names=[...new Set([...l.keys(),...r.keys()])].sort();for(const name of names){const parts=name.split('/');parts.pop();while(parts.length){if(l.has(parts.join('/'))||r.has(parts.join('/')))throw Error('文件与目录路径冲突：'+name);parts.pop();}}return names.map(k=>{const a=l.get(k),b=r.get(k),name=a?.path||b.path,old=Object.hasOwn(base,name)?base[name]:null;if(a&&b&&a.path!==b.path)throw Error('本地与云端文件名大小写不一致：'+name);const status=a&&b?(a.hash===b.hash?'identical':!old?'conflict':a.hash===old?'download':b.hash===old?'upload':'conflict'):a?(old?'remote-missing':'upload'):old?'local-missing':'download';return {path:name,status,local:a?.hash||null,remote:b?.hash||null};});}
async function preview(dir,cwd,base,exclude){const local=await files.capture(cwd,{exclude}),remote=await dir.capture(exclude);return {rows:compare(local,remote,base),local,remote};}
async function apply(dir,cwd,base,exclude,expected,stateDir){
  const current=await preview(dir,cwd,base,exclude);if(JSON.stringify(current.rows)!==JSON.stringify(expected))throw Error('文件已改变，请重新比较');
  const next=Object.assign(Object.create(null),base),results=[],batch=path.join(stateDir,'direct-backups',core.uuid());await fs.mkdir(batch,{recursive:true});
  const reportPath=path.join(batch,'report.json');let error=null;
  try{for(const row of current.rows){
    if(row.status==='identical'){next[row.path]=row.local;continue;}
    if(!['upload','download'].includes(row.status)){results.push({path:row.path,status:row.status});continue;}
    const a=current.local.files.find(f=>f.path===row.path),b=current.remote.files.find(f=>f.path===row.path);
    const now=await files.capture(cwd,{exclude});if((now.files.find(f=>f.path===row.path)?.hash||null)!==row.local)throw Error('本地文件已变化：'+row.path);
    if(row.status==='upload'){
      if(b)await fs.writeFile(path.join(batch,results.length+'.remote.bin'),b.data,{flag:'wx'});
      await dir.put(row.path,a.data,b?.etag??(b?undefined:null));
      if(core.hash((await dir.get(row.path)).data)!==a.hash)throw Error('上传校验失败：'+row.path);next[row.path]=a.hash;
    }else{
      const latest=await dir.get(row.path);if(core.hash(latest.data)!==b.hash)throw Error('云端文件已变化：'+row.path);
      const manifest={version:1,files:[{path:b.path,hash:b.hash,size:b.size}],total:b.size};
      await files.apply({get:async()=>latest.data.toString('base64')},manifest,cwd,base,stateDir);next[row.path]=b.hash;
    }
    results.push({path:row.path,status:row.status});await core.atomic(reportPath,JSON.stringify({state:'applying',results,baseline:next},null,2));
  }}catch(e){error=e.message;}
  await core.atomic(reportPath,JSON.stringify({state:error?'partial':'complete',error,results,baseline:next},null,2));return {baseline:next,results,error,reportPath};
}
module.exports={Directory,endpoint,listing,compare,preview,apply};
