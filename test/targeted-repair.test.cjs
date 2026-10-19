const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const sync=require('../project-sync.cjs'),core=require('../core.cjs'),io=require('../session-io.cjs');
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'desk-repair-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.mkdir(path.join(home,'sessions'));const file=path.join(home,'sessions','one.jsonl');const raw=JSON.stringify({type:'session_meta',payload:{id:'one',cwd:home}})+'\n';await fs.writeFile(file,raw);return {home,file,raw,report:{home,results:[{id:'one',status:'imported'}],sessionFiles:{one:file},expectedDirectories:{one:home},projectSettings:{mode:'cli'},verification:{results:[{id:'one',cwd:'D:/old',pathMatches:false}]}}};}
test('single repair backs up, repairs one index and never mutates other threads',async t=>{
 const {home,file,raw,report}=await fixture(t);const other=path.join(home,'sessions','unrelated.jsonl');await fs.writeFile(other,'broken unrelated record');let cwd='D:/old';const calls=[];
 const request=async(method,p)=>{calls.push({method,p});if(method==='thread/list')return {data:[]};if(method==='thread/read')return {thread:{id:'one',cwd}};if(method==='thread/resume'){assert.equal(p.excludeTurns,true);assert.equal(p.threadId,'one');assert.equal(p.cwd,home);cwd=p.cwd;return {thread:{id:'one',cwd,turns:[]}};}throw Error(method);};
 const result=await sync.repair('fake',report,'one',()=>{},{updateIndex:async(_,change,backup)=>{assert.equal(change.id,'one');assert.equal(change.to,home);await backup({id:'one',cwd});cwd=change.to;},withClient:async(_,__,fn)=>fn(request)});
 assert.equal(result.complete,true);assert.equal(await fs.readFile(file,'utf8'),raw);assert.equal(await fs.readFile(other,'utf8'),'broken unrelated record');assert.equal(await fs.readFile(path.join(path.dirname(result.repairReport),'original.jsonl'),'utf8'),raw);assert.ok(calls.every(c=>!c.p.threadId||c.p.threadId==='one'));
});
test('invalid IDs cannot start a repair',async t=>{const {report}=await fixture(t);const services={withClient:async()=>{throw Error('must not connect')}};await assert.rejects(sync.repair('fake',report,'other',()=>{},services),/只能修复/);});
test('targeted validation rejects escaped paths and mismatched file IDs',async t=>{const {report,file}=await fixture(t);report.sessionFiles.one=path.join(report.home,'..','outside.jsonl');await assert.rejects(sync.recoveryRows(report,['one']),/路径无效/);report.sessionFiles.one=file;await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'different',cwd:report.home}})+'\n');await assert.rejects(sync.recoveryRows(report,['one']),/ID 已变化/);});
test('metadata scan reuses unchanged files, invalidates changes, and drops deleted sessions',async t=>{
 const {home,file}=await fixture(t);const inspect=io.inspect;let reads=0;io.inspect=async(...a)=>{reads++;return inspect(...a)};t.after(()=>{io.inspect=inspect});
 await core.scan(home,{previewLimit:0});assert.equal(reads,1);await core.scan(home,{previewLimit:0});assert.equal(reads,1);
 await fs.appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'notice'}})+'\n');await core.scan(home,{previewLimit:0});assert.equal(reads,2);
 await fs.unlink(file);assert.equal((await core.scan(home,{previewLimit:0})).sessions.length,0);
});
test('index adapter updates only the exact row, rolls back failed backup and rejects changed path',async t=>{
 const {home,file}=await fixture(t),{DatabaseSync}=require('node:sqlite'),index=require('../codex-index.cjs');
 const db=new DatabaseSync(path.join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,title TEXT)');db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('one','D:/old',file,'unchanged');db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('other','D:/other','other.jsonl','other title');db.close();
 const change={id:'one',file,from:'D:/old',to:home};await assert.rejects(index.update(home,change,async()=>{throw Error('backup failed')}),/backup failed/);
 await index.update(home,change);await assert.rejects(index.update(home,change),/已变化/);
 const read=new DatabaseSync(path.join(home,'state_5.sqlite'));assert.equal(read.prepare('SELECT cwd FROM threads WHERE id=?').get('one').cwd,home);assert.equal(read.prepare('SELECT title FROM threads WHERE id=?').get('one').title,'unchanged');assert.equal(read.prepare('SELECT cwd FROM threads WHERE id=?').get('other').cwd,'D:/other');read.close();
});
test('unsupported database version is left untouched',async t=>{const {home,file}=await fixture(t);await fs.writeFile(path.join(home,'state_6.sqlite'),'future format');await assert.rejects(require('../codex-index.cjs').update(home,{id:'one',file,from:'old',to:home}),/不受支持/);assert.equal(await fs.readFile(path.join(home,'state_6.sqlite'),'utf8'),'future format');});
