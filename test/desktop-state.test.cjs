const {test}=require('node:test'),assert=require('node:assert/strict'),d=require('../desktop-state.cjs');
test('native IDs keep projects with the same root independent; storage and home scope bindings',()=>{
 const state={home:'C:/codex'};d.migrate(state);const config={type:'local',directory:'D:/cloud'};
 for(const id of ['a','b']){state.desktopProjects[d.key(state.home,'codex:'+id)]={cwd:'D:/shared',name:id};state.desktopBindings[d.bindingKey(config,state.home,'codex:'+id)]='cloud-'+id;}
 assert.equal(d.get(state,'codex:a').name,'a');assert.equal(d.find(state,config,'cloud-b'),'codex:b');
 assert.equal(d.find({...state,home:'C:/other'},config,'cloud-b'),undefined);
 assert.equal(d.find(state,{...config,directory:'D:/else'},'cloud-b'),undefined);
});
test('old path settings migrate once without destroying originals or reintroducing changed bindings',()=>{
 const home='C:/Codex',cwd='D:/Work',config={type:'local',directory:'D:/cloud'};
 const state={home,conversationProjects:{[JSON.stringify([home,cwd])]:{mode:'desktop',sourceProjectId:'p',roots:[cwd],threadIds:['t']}},bindings:{[JSON.stringify(['local','D:/cloud','',cwd])]:'shared'}};
 d.migrate(state);assert.equal(d.get(state,'codex:p').cwd,cwd);assert.equal(d.find(state,config,'shared'),'codex:p');
 state.desktopBindings={};d.migrate(state);assert.equal(d.find(state,config,'shared'),undefined);assert.equal(Object.keys(state.bindings).length,1);
});
