const {test}=require('node:test'),assert=require('node:assert/strict'),{rename}=require('../desktop-properties.cjs');
test('rename uses native metadata only, verifies result and detects stale edits',async()=>{
 for(const kind of ['thread','project']){const record={id:'a',name:'Before',cwd:'D:/work',projectId:'p'},calls=[];
 const request=async(method,params)=>{calls.push(method);if(method.endsWith('/read'))return {[kind]:{...record}};record.name=params.name;return {};};
 const result=await rename(request,{kind,id:'a',value:'After',expected:'Before'});assert.equal(result.after,'After');assert.equal(record.cwd,'D:/work');assert.equal(record.projectId,'p');assert.equal(calls[1],kind==='project'?'project/update':'thread/name/set');
 await assert.rejects(rename(request,{kind,id:'a',value:'Again',expected:'Before'}),/其他窗口/);
 }
});
test('move refuses stale membership and changes only project assignment',async()=>{
 const {move}=require('../desktop-properties.cjs');const thread={id:'t',projectId:'a',cwd:'D:/unchanged'};
 const request=async(method,p)=>{if(method==='thread/read')return {thread:{...thread}};if(method==='project/read')return {project:{id:p.projectId}};if(method==='thread/metadata/update'){thread.projectId=p.projectId;return {};}throw Error(method);};
 await assert.rejects(move(request,{id:'t',targetProjectId:'b',expectedNativeProjectId:'old'}),/归属已变化/);
 assert.equal(thread.projectId,'a');const result=await move(request,{id:'t',targetProjectId:'b',expectedNativeProjectId:'a'});assert.equal(result.projectId,'b');assert.equal(result.cwd,'D:/unchanged');
});
test('unnamed threads can acquire a native title independently of their preview text',async()=>{
 const thread={id:'t',name:null,preview:'Preview differs from the message shown in UI'};
 const request=async(method,p)=>{if(method==='thread/read')return {thread:{...thread}};thread.name=p.name;return {};};
 assert.equal((await rename(request,{kind:'thread',id:'t',value:'Named',expected:null})).after,'Named');
});
