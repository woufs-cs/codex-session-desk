// Full rollout files are authoritative. Only derived per-thread paging rows are rebuilt.
const fs=require('node:fs/promises'),path=require('node:path'),io=require('./session-io.cjs'),rpc=require('./codex-rpc.cjs');
async function resetProjection(home,id){
 const file=path.join(home,'thread_history_1.sqlite');if(!await fs.stat(file).catch(()=>null))return;
 await require('./recovery.cjs').safePath(file);const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file);let active=false;
 try{db.exec('PRAGMA busy_timeout=2000');const required={thread_turns:['thread_id','turn_id','rollout_ordinal'],thread_items:['thread_id','item_id','item_json','rollout_ordinal'],thread_history_projection_state:['thread_id','next_rollout_ordinal'],thread_realtime_items:['thread_id','item_id','item_json']};
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);for(const [name,cols]of Object.entries(required)){if(!names.includes(name))throw Error('分页历史数据库结构不受支持：'+name);const actual=db.prepare('PRAGMA table_info('+name+')').all().map(r=>r.name);if(!cols.every(k=>actual.includes(k)))throw Error('分页历史表结构不受支持：'+name);}
 for(const name of names){if(!/^[a-zA-Z0-9_]+$/.test(name))throw Error('未知分页表名称');if(!required[name]&&db.prepare('PRAGMA table_info('+name+')').all().some(c=>c.name==='thread_id'))throw Error('出现未知分页表，停止重建：'+name);}
 db.exec('BEGIN IMMEDIATE');active=true;for(const name of Object.keys(required))db.prepare('DELETE FROM '+name+' WHERE thread_id=?').run(id);db.exec('COMMIT');active=false;
 }finally{if(active)db.exec('ROLLBACK');db.close();}
}
async function refresh(executable,home,row,onProgress=()=>{},services={stopped:require('./codex-lifecycle.cjs').requireStopped,client:rpc.withClient}){
 await services.stopped();const s=await io.inspect(row.file,{previewLimit:0});if(s.id!==row.id||s.digest!==row.digest||s.historyMode!=='paginated')throw Error('分页历史源文件已变化，停止索引重建');
 // Keep only IDs, never retain all message bodies or image data.
 const expected=new Set();let last=-1;for await(const {line}of io.compactLines(io.chunks(row.file))){if(!line)continue;const r=JSON.parse(line);if(!Number.isSafeInteger(r.ordinal)||r.ordinal<=last)throw Error('分页历史序号无效，未修改索引');last=r.ordinal;if(r.type==='event_msg'&&r.payload?.type==='item_completed'&&r.payload.item?.id)expected.add(r.payload.item.id);}
 await services.stopped();if(await io.hashFile(row.file)!==row.digest)throw Error('分页源文件在准备期间变化，未重建索引');
 onProgress({stage:'重建分页历史索引',detail:row.id});await resetProjection(home,row.id);
 await services.client(executable,home,async request=>{await request('thread/resume',{threadId:row.id,excludeTurns:true});let cursor;const seen=new Set(),found=new Set();do{const page=await request('thread/items/list',{threadId:row.id,limit:20,...(cursor?{cursor}:{})});for(const entry of page.data||[])if(entry.item?.id)found.add(entry.item.id);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('分页游标重复，验证未完成');seen.add(cursor);}while(cursor);
 if([...expected].some(id=>!found.has(id)))throw Error('分页索引未完整识别源记录，请保留源文件并重试验证');});
 return {verified:true};
}
module.exports={refresh,resetProjection};
