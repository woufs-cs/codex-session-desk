const {test}=require('node:test'),assert=require('node:assert/strict');
const {manage}=require('../codex-lifecycle.cjs');
function fake({refuse=false,cli=false}={}){let running=[{ProcessId:1,ExecutablePath:'D:/Codex.exe'},...(cli?[{ProcessId:2,ExecutablePath:'D:/cli/codex.exe'}]:[])],restarts=0,closes=0;const adapter={list:async()=>running,desktopApps:async()=>[{pid:1,path:'D:/Codex.exe'}],close:async()=>{closes++;if(!refuse)running=running.filter(x=>x.ProcessId!==1);},restart:async()=>{restarts++;},sleep:async()=>{}};return {adapter,counts:()=>({restarts,closes})};}
test('opt-in lifecycle closes and restarts only the previously running desktop',async()=>{const f=fake();assert.equal(await manage(true,async()=>'done',{adapter:f.adapter,timeout:0}),'done');assert.deepEqual(f.counts(),{restarts:1,closes:1});});
test('receive failure still restarts the desktop without hiding the error',async()=>{const f=fake();await assert.rejects(manage(true,async()=>{throw Error('disk failed')},{adapter:f.adapter,timeout:0}),/disk failed/);assert.equal(f.counts().restarts,1);});
test('unclosed desktop and CLI block writes and are never force-killed',async()=>{for(const options of [{refuse:true},{cli:true}]){const f=fake(options);let wrote=false;await assert.rejects(manage(true,async()=>{wrote=true},{adapter:f.adapter,timeout:0}),/尚未完全退出/);assert.equal(wrote,false);assert.equal(f.counts().restarts,options.refuse?0:1);}});
test('without opt-in the running desktop is left untouched',async()=>{const f=fake();await assert.rejects(manage(false,async()=>{}, {adapter:f.adapter}),/尚未完全退出/);assert.deepEqual(f.counts(),{restarts:0,closes:0});});
test('confirmed force closure targets only desktop-owned leftovers and still blocks independent CLI',async()=>{
 const desktop={ProcessId:1,CreationDate:'first',ExecutablePath:'D:/Codex.exe'},helper={ProcessId:3,ParentProcessId:1,CreationDate:'third',ExecutablePath:'D:/Codex.exe',CommandLine:'--type=renderer'},cli={ProcessId:2,CreationDate:'second',ExecutablePath:'D:/cli/codex.exe'};
 let running=[desktop,helper,cli],forced=[],wrote=false;
 const adapter={list:async()=>running,desktopApps:async()=>[{pid:1,path:desktop.ExecutablePath}],close:async()=>{running=[helper,cli]},force:async rows=>{forced=rows;running=[cli]},restart:async()=>{},sleep:async()=>{throw Error('no polling expected')}};
 // Use no CLI after force to test the successful path without a real wait.
 adapter.force=async rows=>{forced=rows;running=[]};
 await manage(true,async()=>{wrote=true},{adapter,timeout:0,confirmForce:async rows=>{assert.deepEqual(rows.map(r=>r.ProcessId),[3]);return true}});
 assert.equal(wrote,true);assert.deepEqual(forced.map(r=>r.ProcessId),[3]);
});
test('PID reuse is never treated as an owned leftover',()=>{const {ownedProcesses}=require('../codex-lifecycle.cjs');assert.deepEqual(ownedProcesses([{ProcessId:1,CreationDate:'new',ExecutablePath:'D:/cli/codex.exe'}],[{pid:1,path:'D:/Codex.exe'}],[{ProcessId:1,CreationDate:'old',ExecutablePath:'D:/Codex.exe'}]),[]);});
