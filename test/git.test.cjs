const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const service=require('../git-service.cjs');
const git=async(cwd,...args)=>(await promisify(execFile)('git',['-C',cwd,...args],{windowsHide:true})).stdout;
test('visual Git workflow stages, unstages, commits, pushes and fast-forward pulls',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'desk-git-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const a=path.join(base,'a'),b=path.join(base,'b'),remote=path.join(base,'remote');await fs.mkdir(a);await fs.mkdir(remote);await git(remote,'init','--bare');await git(a,'init');await git(a,'config','user.name','Test');await git(a,'config','user.email','test@example.invalid');
  await fs.writeFile(path.join(a,'a space.txt'),'first');assert.equal((await service.status(a)).files[0].untracked,true);assert.equal(await service.diff(a,'a space.txt',false),'first');
  await service.action(a,'stage','a space.txt');await service.action(a,'unstage','a space.txt');assert.equal((await service.status(a)).files[0].untracked,true);
  await service.action(a,'stage','a space.txt');await service.action(a,'commit',null,'initial');await git(a,'remote','add','origin',remote);await git(a,'push','-u','origin','HEAD');await git(base,'clone',remote,b);
  await fs.writeFile(path.join(a,'a space.txt'),'second');assert.match(await service.diff(a,'a space.txt',false),/second/);await service.action(a,'stage','a space.txt');await service.action(a,'commit',null,'second');await service.action(a,'push');await service.action(b,'fetch');assert.equal((await service.status(b)).behind,1);await service.action(b,'pull');assert.equal(await fs.readFile(path.join(b,'a space.txt'),'utf8'),'second');
  await fs.writeFile(path.join(b,'a space.txt'),'local edits');await assert.rejects(service.action(b,'pull'),/工作区/);
});
test('porcelain parser keeps spaces and rename pairs',()=>{const r=service.parseStatus('R  new name\0old name\0?? space name\0UU conflict\0');assert.equal(r[0].path,'new name');assert.equal(r[0].from,'old name');assert.equal(r[1].path,'space name');assert.equal(r[2].conflict,true);});
