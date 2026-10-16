const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const flow=require('../git-workflow.cjs'),{git,action}=require('../git-service.cjs'),{rows}=require('../diff-view.js');
const clean={files:[],branch:'main',upstream:'origin/main',ahead:0,behind:0};
test('sync recommendation never auto-resolves dirty, detached, operation or diverged states',()=>{
  assert.equal(flow.advice(clean).code,'synced');assert.equal(flow.advice({...clean,ahead:2}).action,'push');assert.equal(flow.advice({...clean,behind:2}).action,'pull');
  for(const state of [{ahead:1,behind:1},{files:[{index:'M'}]},{operation:'MERGE_HEAD'},{branch:'(detached HEAD)'},{upstream:''},{files:[{conflict:true}]}])assert.equal(flow.advice({...clean,...state}).action,null);
});
test('clone endpoints reject embedded secrets and executable transport syntax',()=>{
  for(const value of ['-x','ext::sh cmd','https://user:token@example.com/repo','https://example.com/repo?token=secret','file:///tmp/repo'])assert.throws(()=>flow.validUrl(value));
  for(const value of ['https://github.com/example/repo.git','git@github.com:example/repo.git','ssh://git@example.com/repo'])assert.doesNotThrow(()=>flow.validUrl(value));
});
test('split diff preserves numbering and handles multiple headers without looping',()=>{
  const result=rows('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old\n+new\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -0,0 +1 @@\n+added');
  const changes=result.filter(r=>r.changed);assert.equal(changes.length,2);assert.equal(changes[0].left,'old');assert.equal(changes[0].right,'new');assert.equal(changes[0].leftNumber,2);assert.equal(changes[1].rightNumber,1);
});
test('repository inspection detects real divergence, blocks dirty switches, and switches clean branches',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desk-workflow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const a=path.join(dir,'a'),b=path.join(dir,'b'),remote=path.join(dir,'remote');for(const p of [a,remote])await fs.mkdir(p);
  await git(remote,['init','--bare']);await git(a,['init','-b','main']);await git(a,['config','user.name','Test']);await git(a,['config','user.email','test@example.invalid']);await fs.writeFile(path.join(a,'file'),'base');await git(a,['add','.']);await git(a,['commit','-m','base']);await git(a,['remote','add','origin',remote]);await git(a,['push','-u','origin','main']);await git(dir,['clone','-b','main',remote,b]);await git(b,['config','user.name','Test']);await git(b,['config','user.email','test@example.invalid']);
  await fs.writeFile(path.join(a,'file'),'A');await git(a,['commit','-am','A']);await action(a,'push');await fs.writeFile(path.join(b,'file'),'B');await assert.rejects(flow.branch(b,'feature',true),/工作区/);await git(b,['commit','-am','B']);await action(b,'fetch');assert.equal((await flow.inspect(b)).advice.code,'diverged');await assert.rejects(action(b,'pull'));
  await flow.branch(b,'feature',true);assert.equal((await flow.inspect(b)).branch,'feature');await flow.branch(b,'main',false);await flow.upstream(b,'origin/main');assert.equal((await flow.inspect(b)).upstream,'origin/main');
  await flow.remote(b,'review','https://example.invalid/test.git');assert((await flow.inspect(b)).remotes.includes('review'));
  await fs.writeFile(path.join(b,'occupied'),'x');await assert.rejects(flow.clone('https://example.invalid/test.git',b),/空目录/);
});
