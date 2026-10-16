const {test}=require('node:test'),assert=require('node:assert/strict'),{validateProfile}=require('../desktop-policy.cjs');
const sessions=[{id:'one'},{id:'other'},{id:'loose'}],inventory={projects:[{id:'p'}],threads:[{id:'one',projectId:'p'},{id:'other',projectId:'q'},{id:'loose',projectId:null}]};
test('desktop release accepts native project members but not standalone directory or foreign threads',()=>{
  const p={mode:'desktop',name:'Paper',sourceProjectId:'p',threadIds:['one']};assert.deepEqual(validateProfile(p,sessions,inventory),['one']);
  assert.throws(()=>validateProfile({...p,mode:'cli'},sessions,inventory),/桌面端/);
  assert.throws(()=>validateProfile({...p,sourceProjectId:null},sessions,inventory),/来源/);
  for(const id of ['other','loose'])assert.throws(()=>validateProfile({...p,threadIds:[id]},sessions,inventory),/属于/);
});
test('receiving an empty project is allowed, missing histories and invalid titles are rejected',()=>{
  assert.deepEqual(validateProfile({mode:'desktop',name:'Remote',threadIds:[]},[],inventory),[]);
  assert.throws(()=>validateProfile({mode:'desktop',name:' ',threadIds:[]},[],inventory),/名称/);
  assert.throws(()=>validateProfile({mode:'desktop',name:'Paper',sourceProjectId:'p',threadIds:['missing']},sessions,inventory),/不可用/);
});
