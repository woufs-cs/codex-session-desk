const {test}=require('node:test'),assert=require('node:assert/strict');
const mac=require('../mac-lifecycle.cjs');
test('Mac process identification handles spaces, excludes unrelated apps, includes descendants',async()=>{
 const rows=mac.parseProcesses(`12 1 Thu Oct 22 12:00:00 2026 /Volumes/My Disk/Codex.app/Contents/MacOS/Codex
13 12 Thu Oct 22 12:00:01 2026 /Volumes/My Disk/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper
14 12 Thu Oct 22 12:00:02 2026 /bin/sh
20 1 Thu Oct 22 12:01:00 2026 /opt/homebrew/bin/codex
30 1 Thu Oct 22 12:01:00 2026 /Applications/Other.app/Contents/MacOS/Other`);
 assert.deepEqual(rows.map(r=>r.ProcessId),[12,13,14,20]);assert.deepEqual(await mac.desktopApps(rows),[{pid:12,path:'/Volumes/My Disk/Codex.app'}]);
});
test('Windows lifecycle loads without accessing uninitialized adapter fields',()=>{assert.equal(typeof require('../codex-lifecycle.cjs').manage,'function');});
test('Windows to Mac and Mac to Windows mapping preserves subdirectories',()=>{
 const m=require('../project-model.cjs');const d=m.define('Paper','D:\\Project\\paper reading',[],[]);
 assert.equal(m.targetPath({rootId:'root-0',relative:'notes'},d,{'root-0':'/Users/test/Projects/paper reading'}),'/Users/test/Projects/paper reading/notes');
 const back=m.define('Paper','/Users/test/Projects/paper reading',[],[]);assert.equal(m.targetPath({rootId:'root-0',relative:'notes'},back,{'root-0':'D:\\Paper'}),'D:\\Paper\\notes');
});
test('Mac package contains only explicit runtime files and excludes local data',()=>{
 const c=require('../electron-builder.mac.json');assert.ok(c.files.includes('mac-lifecycle.cjs'));assert.ok(c.files.every(f=>!f.includes('*')&&!/test-data|\.env|settings/.test(f)));assert.equal(c.publish,null);
});
test('Mac lifecycle adapter loads and detects blockers without calling Windows tools',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),path=require('node:path');const real=createRequire(path.resolve(__dirname,'../codex-lifecycle.cjs'));let calls=0;
 const sandbox={module:{exports:{}},process:{platform:'darwin'},Buffer,setTimeout,require:n=>n==='./mac-lifecycle.cjs'?{list:async()=>{calls++;return [{ProcessId:1}]}}:real(n)};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../codex-lifecycle.cjs'),'utf8'),sandbox);await assert.rejects(sandbox.module.exports.requireStopped(),/完全退出/);assert.equal(calls,1);
});
test('Mac CLI npm symlink resolves to native executable instead of Node launcher',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),util=require('node:util');let invoked;
 const execFile=()=>{};execFile[util.promisify.custom]=async(file)=>{invoked=file;return {stdout:'codex-cli 0.1.0'};};
 const sandbox={module:{exports:{}},process:{platform:'darwin',arch:'arm64',env:{}},require:n=>n==='node:fs/promises'?{realpath:async()=>'/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',access:async()=>{}}:n==='node:path'?path.posix:n==='node:child_process'?{execFile}:require(n)};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../codex-cli.cjs'),'utf8'),sandbox);const result=await sandbox.module.exports.check('/opt/homebrew/bin/codex');assert.ok(invoked.endsWith('/vendor/aarch64-apple-darwin/bin/codex'));assert.equal(result.path,invoked);
});
