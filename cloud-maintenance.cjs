'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const core=require('./core.cjs'),journal=require('./project-journal.cjs');
const resource=/^(?:(?:object-[a-f0-9]{64}\.jsonl)|(?:pack-[a-f0-9]{64}\.json)|(?:(?:text|image)-[a-f0-9]{64}\.gz)|(?:file-[a-f0-9]{64}\.b64))$/;
const metadata=/^(?:update-[a-f0-9]{64}\.json|commit-[a-f0-9-]+\.json|current\.json|checkpoint-v1\.json)$/;
const unescape=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
function parseInventory(xml,url){
 const rows=[],base=new URL(url);for(const match of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)){
  const body=match[1],href=body.match(/<(?:[\w-]+:)?href\b[^>]*>([^<]+)<\/(?:[\w-]+:)?href>/i)?.[1];if(!href)continue;
  const target=new URL(unescape(href),base);if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname))continue;
  const name=decodeURIComponent(target.pathname.slice(base.pathname.length));if(!name||/[\\/]/.test(name))continue;
  const success=[...body.matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)].map(m=>m[1]).filter(s=>/HTTP\/\d(?:\.\d)?\s+200\b/.test(s)).join('');
  if(/<(?:[\w-]+:)?collection\b/i.test(success))continue;
  const size=success.match(/<(?:[\w-]+:)?getcontentlength\b[^>]*>\s*(\d+)\s*<\//i)?.[1],bytes=size===undefined?null:Number(size);
  rows.push({name,bytes:Number.isSafeInteger(bytes)&&bytes>=0?bytes:null});
 }return [...new Map(rows.map(r=>[r.name,r])).values()];
}
async function inventory(store){
 if(store.config.type!=='webdav'){const rows=[];for(const name of await store.list()){const st=await fs.lstat(path.join(store.config.directory,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(st?.isFile())rows.push({name,bytes:st.size});}return rows;}
 const response=await store.request('','PROPFIND'),chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('空间统计目录列表超过 8 MB 限制');chunks.push(Buffer.from(chunk));}
 return parseInventory(Buffer.concat(chunks).toString('utf8'),store.url);
}
const summarize=rows=>({files:rows.length,bytes:rows.reduce((sum,r)=>sum+(r.bytes||0),0),unknownSizes:rows.filter(r=>r.bytes===null).length});
async function analyze(store,onProgress=()=>{}){
 onProgress({stage:'读取云端资源目录'});const rows=await inventory(store),view=require('./project-current.cjs').inheritLegacy(await core.catalog(store));if(!view)throw Error('项目没有可用发布记录');
 const active=new Set(),conflicted=new Set(),manifests=new Map();
 async function mark(o,set){if(!o.encoding){set.add('object-'+o.hash+'.jsonl');return;}
  const key='pack-'+o.manifestHash+'.json';set.add(key);let m=manifests.get(key);if(!m){const raw=await store.get(key);if(core.hash(raw)!==o.manifestHash)throw Error('重建清单校验失败');m=require('./session-pack.cjs').validate(JSON.parse(raw),o.hash);manifests.set(key,m);}else require('./session-pack.cjs').validate(m,o.hash);
  set.add('text-'+m.text.hash+'.gz');for(const image of m.images)set.add('image-'+image.hash+'.gz');
 }
 const objects=[...view.objects,...(view.cloudConflicts||[]).flatMap(c=>c.variants.map(v=>v.object))];let completed=0;
 for(const o of view.objects){onProgress({stage:'统计当前内容引用（不下载图片）',current:completed++,total:objects.length});await mark(o,active);}
 for(const c of view.cloudConflicts||[])for(const v of c.variants){onProgress({stage:'保护未解决冲突',current:completed++,total:objects.length});await mark(v.object,conflicted);}
 for(const f of view.fileSnapshot?.files||[])active.add('file-'+f.hash+'.b64');
 const listed=new Set(rows.map(r=>r.name)),missing=[...new Set([...active,...conflicted])].filter(k=>!listed.has(k));
 const end=require('./project-current.cjs').inheritLegacy(await core.catalog(store));
 const stable=end?.id===view.id,unused=rows.filter(r=>resource.test(r.name)&&!active.has(r.name)&&!conflicted.has(r.name));
 return {projectId:view.projectId,stable,missing,automaticDeletion:false,reason:'当前存储协议不能安全协调所有发布与接收设备；未引用资源仅供统计，不自动删除。',current:summarize(rows.filter(r=>active.has(r.name))),conflicts:summarize(rows.filter(r=>conflicted.has(r.name)&&!active.has(r.name))),unreferenced:summarize(unused),metadata:summarize(rows.filter(r=>metadata.test(r.name))),other:summarize(rows.filter(r=>!resource.test(r.name)&&!metadata.test(r.name))),total:summarize(rows),records:rows.filter(r=>/^update-/.test(r.name)).length,checkpoint:listed.has('checkpoint-v1.json')};
}
async function checkpoint(store,onProgress=()=>{}){onProgress({stage:'整理可重建的发布检查点'});const rows=await journal.records(store);if(!rows.length)return {status:'legacy',records:0};return require('./publication-checkpoint.cjs').write(store,rows,{force:true});}
module.exports={analyze,checkpoint,inventory,parseInventory};
