// Deliberately narrow compatibility adapter. Never creates/migrates the Codex DB.
const fs=require('node:fs/promises'),path=require('node:path'),model=require('./project-model.cjs');
async function open(home){
 const files=(await fs.readdir(home)).filter(n=>/^state_\d+\.sqlite$/.test(n));
 if(files.length!==1||files[0]!=='state_5.sqlite')throw Error('Codex 索引版本不受支持或存在多个索引；尚未修改，请保留报告');
 const file=path.join(home,files[0]);await require('./recovery.cjs').safePath(file);
 const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(file,{enableForeignKeyConstraints:true});
 try{db.exec('PRAGMA busy_timeout=2000');const columns=db.prepare('PRAGMA table_info(threads)').all();if(!['id','cwd','rollout_path'].every(n=>columns.some(c=>c.name===n)))throw Error('Codex threads 索引结构不兼容');return db;}catch(e){db.close();throw e;}
}
async function update(home,{id,file,from,to},beforeWrite=async()=>{}){
 const db=await open(home);let transaction=false;
 try{
  db.exec('BEGIN IMMEDIATE');transaction=true;
  const row=db.prepare('SELECT id,cwd,rollout_path FROM threads WHERE id=?').get(id);
  if(!row||!model.same(row.rollout_path,file)||!model.same(row.cwd,from))throw Error('索引中的对话、文件或目录已变化，停止修复；请重新验证');
  await beforeWrite({...row});
  const result=db.prepare('UPDATE threads SET cwd=? WHERE id=? AND cwd=? AND rollout_path=?').run(to,id,row.cwd,row.rollout_path);
  if(result.changes!==1)throw Error('单条索引更新未通过检查');db.exec('COMMIT');transaction=false;
  return {...row};
 }finally{if(transaction)db.exec('ROLLBACK');db.close();}
}
module.exports={update};
