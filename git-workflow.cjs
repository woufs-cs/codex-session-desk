const fs=require('node:fs/promises'),path=require('node:path'),base=require('./git-service.cjs');
const {git}=base;
function advice(s){
  if(s.operation)return {code:'operation',title:'先完成正在进行的 Git 操作',detail:s.operation,action:null};
  if(s.files.some(f=>f.conflict))return {code:'conflict',title:'先解决文件冲突',detail:'请在编辑器中处理冲突，再刷新检查；不会替你覆盖任一侧。',action:null};
  if(s.branch==='(detached HEAD)')return {code:'detached',title:'当前不在分支上',detail:'请先创建分支保留当前工作，再同步。',action:null};
  if(s.files.length)return {code:'dirty',title:'先整理并提交本地改动',detail:'选择要同步的文件暂存，填写提交说明。未暂存文件不会自动加入提交。',action:null};
  if(!s.upstream)return {code:'upstream',title:'设置上游分支',detail:'已有远端分支可设为上游，或发布当前分支。',action:null};
  if(s.ahead&&s.behind)return {code:'diverged',title:'两端历史已分叉',detail:'需要在 Git 工具中合并或 rebase。不会自动强推、重置或丢弃提交。',action:null};
  if(s.behind)return {code:'behind',title:`可拉取 ${s.behind} 个提交`,detail:'仅快进更新，保留已有历史。',action:'pull'};
  if(s.ahead)return {code:'ahead',title:`可推送 ${s.ahead} 个提交`,detail:'确认后推送到当前分支的上游。',action:'push'};
  return {code:'synced',title:'与已知上游一致',detail:'点击“检查并同步”先获取最新远端状态。',action:null};
}
async function inspect(cwd){
  const s=await base.status(cwd);let operation=null;
  for(const marker of ['MERGE_HEAD','rebase-merge','rebase-apply','CHERRY_PICK_HEAD','REVERT_HEAD']){const location=(await git(cwd,['rev-parse','--git-path',marker])).trim();try{await fs.access(path.resolve(cwd,location));operation=marker;break;}catch{}}
  const branches=(await git(cwd,['for-each-ref','--format=%(refname:short)','refs/heads'])).trim().split('\n').filter(Boolean);
  const upstreams=(await git(cwd,['for-each-ref','--format=%(refname:short)','refs/remotes'])).trim().split('\n').filter(x=>x&&!x.endsWith('/HEAD'));
  const remotes=(await git(cwd,['remote'])).trim().split('\n').filter(Boolean);
  const result={...s,operation,branches,upstreams,remotes};return {...result,advice:advice(result)};
}
async function quiet(cwd){const s=await inspect(cwd);if(s.files.length||s.operation)throw Error('工作区有改动或 Git 操作尚未结束，请先处理');return s;}
async function branch(cwd,name,create){await quiet(cwd);await git(cwd,['check-ref-format','--branch',name]);if(name.startsWith('-'))throw Error('分支名无效');return git(cwd,['switch',...(create?['-c']:[]),name]);}
function validUrl(url){if(typeof url!=='string'||/[\r\n\0]/.test(url)||url.startsWith('-'))throw Error('仓库地址无效');if(/^https:\/\//.test(url)){const u=new URL(url);if(u.username||u.password||u.search||u.hash)throw Error('地址中不要包含密码、令牌或查询参数');return;}if(/^ssh:\/\//.test(url)){const u=new URL(url);if(u.password||u.search||u.hash)throw Error('SSH 地址无效');return;}if(/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url))return;throw Error('请使用 HTTPS 或 SSH 仓库地址');}
async function remote(cwd,name,url){await base.root(cwd);if(!/^[\w][\w.-]*$/.test(name))throw Error('远端名称无效');validUrl(url);const s=await inspect(cwd);return git(cwd,['remote',s.remotes.includes(name)?'set-url':'add',name,url]);}
async function upstream(cwd,ref){await quiet(cwd);const s=await inspect(cwd);if(!s.upstreams.includes(ref))throw Error('请选择已获取的远端分支');return git(cwd,['branch','--set-upstream-to',ref]);}
async function publishBranch(cwd,remoteName){const s=await quiet(cwd);if(!s.remotes.includes(remoteName)||s.branch==='(detached HEAD)')throw Error('远端或当前分支无效');return git(cwd,['push','--set-upstream',remoteName,s.branch]);}
async function clone(url,target){validUrl(url);if(!path.isAbsolute(target))throw Error('克隆路径无效');const st=await fs.lstat(target);if(!st.isDirectory()||st.isSymbolicLink()||(await fs.readdir(target)).length)throw Error('请选择已存在的空目录');return git(target,['clone','--',url,'.']);}
function friendly(error){const message=error.message||String(error);if(/Authentication failed|could not read Username|Permission denied|terminal prompts disabled/i.test(message))return 'Git 认证失败：请先在系统 Git 或 GitHub Desktop 完成登录，再重试。\n'+message;if(/not found|ENOENT.*git|spawn git ENOENT/i.test(message))return '请检查 Git 是否安装、仓库地址是否正确。\n'+message;if(/Could not resolve|Failed to connect|timed out/i.test(message))return '连接失败：检查网络、代理和远端地址后重试。\n'+message;return message;}
module.exports={inspect,advice,branch,remote,upstream,publishBranch,clone,validUrl,friendly};
