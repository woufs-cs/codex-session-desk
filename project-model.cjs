const path=require('node:path');
const plain=p=>typeof p==='string'?p.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\(?=[a-z]:)/i,''):p;
const flavor=p=>/^[a-z]:[\\/]|^\\\\/i.test(p)?path.win32:path.posix;
const canonical=p=>{p=plain(p);const f=flavor(p);const v=f.normalize(p).replace(/[\\/]+$/,'');return f===path.win32?v.toLowerCase():v;};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&canonical(a)===canonical(b);
const absolute=p=>typeof p==='string'&&flavor(p).isAbsolute(p);
function relative(root,cwd){root=plain(root);cwd=plain(cwd);const f=flavor(root);if(f!==flavor(cwd))return null;const rel=f.relative(root,cwd);return rel==='..'||rel.startsWith('..'+f.sep)||f.isAbsolute(rel)?null:rel.split(f.sep).join('/');}
function locate(cwd,roots){let found;for(const r of roots){const rel=relative(r.sourcePath,cwd);if(rel!==null&&(!found||r.sourcePath.length>found.length))found={rootId:r.id,relative:rel,length:r.sourcePath.length};}if(!found)return null;return {rootId:found.rootId,relative:found.relative};}
function validateDefinition(d){
  if(!d||d.version!==1||typeof d.name!=='string'||!d.name.trim()||!Array.isArray(d.roots)||!d.roots.length||d.roots.length>100)throw Error('项目定义无效');
  const ids=new Set();for(const r of d.roots){if(!/^root-[0-9]+$/.test(r.id)||ids.has(r.id)||!absolute(r.sourcePath))throw Error('项目目录定义无效');ids.add(r.id);}
}
function validateWorkspace(w,d){if(!w||!d.roots.some(r=>r.id===w.rootId)||typeof w.relative!=='string'||w.relative.includes('\\')||w.relative.includes(':')||w.relative.includes('\0')||w.relative.startsWith('/')||w.relative.split('/').some(s=>s==='.'||s==='..'))throw Error('对话工作目录映射无效');}
function targetPath(w,d,mapping){validateWorkspace(w,d);const root=mapping[w.rootId];if(!absolute(root))throw Error('请映射目录 '+w.rootId);const result=flavor(root).join(root,...w.relative.split('/').filter(Boolean));if(relative(root,result)===null)throw Error('工作目录超出项目');return result;}
function define(name,cwd,roots,sessions){
  const paths=[cwd,...roots].filter((p,i,a)=>absolute(p)&&a.findIndex(x=>same(x,p))===i);
  // Keep out-of-root worktrees separate rather than flattening their cwd.
  for(const s of sessions)if(!paths.some(p=>relative(p,s.cwd)!==null)){if(!absolute(s.cwd))throw Error('对话缺少绝对工作目录：'+s.id);paths.push(s.cwd);}
  const d={version:1,name,roots:paths.map((sourcePath,i)=>({id:'root-'+i,sourcePath}))};validateDefinition(d);return d;
}
function select(sessions,profile){if(!profile)throw Error('请先在“对话归属与映射”确认要同步的对话');const ids=new Set(profile.threadIds);const chosen=sessions.filter(s=>ids.has(s.id));if(chosen.length!==ids.size)throw Error('成员清单存在丢失或重复的对话，请重新检查');return chosen;}
function preview(rows,definition,mapping){return rows.map(row=>{try{const cwd=targetPath(row.workspace,definition,mapping);return {...row,targetCwd:cwd};}catch(e){return {...row,mappingError:e.message};}});}
module.exports={same,canonical,absolute,relative,locate,define,validateDefinition,validateWorkspace,targetPath,select,preview};
