const {test}=require('node:test'),assert=require('node:assert/strict');
const m=require('../project-model.cjs'),sync=require('../project-sync.cjs');
test('explicit membership is independent of cwd and missing members block publishing',()=>{
  const sessions=[{id:'a',cwd:'D:/main'},{id:'b',cwd:'D:/worktree'},{id:'c',cwd:'D:/main'}];
  assert.deepEqual(m.select(sessions,{threadIds:['a','b']}).map(s=>s.id),['a','b']);
  assert.throws(()=>m.select(sessions),/确认/);assert.throws(()=>m.select(sessions,{threadIds:['missing']}),/丢失/);
});
test('multi-root, subdirectories, different drive letters, and worktrees keep distinct mappings',()=>{
  const sessions=[{cwd:'D:\\main\\scripts'},{cwd:'D:\\worktree'}],d=m.define('Project','D:\\main',['D:\\data'],sessions);
  assert.equal(d.roots.length,3);
  assert.equal(m.targetPath(m.locate(sessions[0].cwd,d.roots),d,{'root-0':'E:\\project'}),'E:\\project\\scripts');
  assert.equal(m.preview([{workspace:m.locate(sessions[1].cwd,d.roots)}],d,{'root-0':'E:\\project'})[0].mappingError,'请映射目录 root-2');
  assert.equal(m.locate('D:\\main-evil',d.roots),null);
  assert.throws(()=>m.targetPath({rootId:'root-0',relative:'../escape'},d,{'root-0':'E:\\project'}),/无效/);
  assert.equal(m.same('/A','/a'),false);assert.equal(m.same('D:/Project','d:\\project'),true);
});
function fake({membership=null,unsupported=false}={}){let project=null,created=0;const thread={id:'t',cwd:'D:/B',projectId:membership};const methods=[];
  const request=async(method,p)=>{methods.push(method);if(unsupported&&method.startsWith('project/'))throw Error('Unsupported method');
    if(method==='project/list')return {data:project?[project]:[]};
    if(method==='project/create'){created++;project={id:'p',roots:p.roots};return {project};}
    if(method==='project/read')return {project:project||{id:'p',roots:[{path:'D:/B'}]}};
    if(method==='thread/list')return {data:p.archived?[]:p.projectId&&p.projectId!==thread.projectId?[]:[{...thread}]};
    if(method==='thread/resume')return {};
    if(method==='thread/read')return {thread:{...thread}};
    if(method==='thread/metadata/update'){thread.projectId=p.projectId;return {};}
    throw Error(method);
  };return {request,methods,count:()=>created};
}
const settings={mode:'desktop',key:'unique',syncId:'cloud',name:'Paper',roots:['D:/B']},rows=[{id:'t',targetCwd:'D:/B'}];
test('desktop binds through native APIs, verifies membership, and reuses saved project',async()=>{
  const f=fake();let id;const first=await sync.reconcile(f.request,settings,rows,{onProject:async value=>id=value});assert.equal(first.complete,true);assert.equal(id,'p');
  await sync.reconcile(f.request,{...settings,projectId:id},rows);assert.equal(f.count(),1);
});
test('CLI preserves an existing desktop membership and needs no project API',async()=>{
  const f=fake({membership:'other',unsupported:true}),r=await sync.reconcile(f.request,{...settings,mode:'cli'},rows);assert.equal(r.complete,true);assert.equal(r.results[0].membership,null);assert.equal(f.methods.some(m=>m.startsWith('project/')||m==='thread/metadata/update'),false);
});
test('membership conflict and unsupported native project APIs stop before mutation',async()=>{
  const f=fake({membership:'other'});await assert.rejects(sync.reconcile(f.request,settings,rows),/归属冲突/);assert.equal(f.methods.includes('thread/metadata/update'),false);assert.equal(f.count(),0);
  const g=fake({unsupported:true});await assert.rejects(sync.reconcile(g.request,settings,rows),/Unsupported/);assert.equal(g.methods.includes('thread/resume'),false);
});
