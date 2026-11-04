const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
if(!isMainThread){
 const progress=value=>parentPort.postMessage({progress:value});
 (async()=>{
  const {task,args}=workerData;require('./core.cjs').seedScanCache(workerData.scanCache);
  if(task==='receive')return require('./recovery.cjs').apply(args.rows,args.cache,args.home,args.cwd,{...args.options,onProgress:progress});
  if(task==='compare')return require('./session-io.cjs').compare(args.local,args.remote,args.mappings||[]);
  if(task==='inspectMetadata')return require('./session-io.cjs').inspect(args.file,{previewLimit:0});
  if(task==='recent')return require('./session-io.cjs').inspect(args.file,{previewLimit:16384,tailCount:6});
  if(task==='inspect')return require('./session-io.cjs').inspect(args.file,{previewLimit:4096});
  if(task==='scan'){
   const core=require('./core.cjs'),fs=require('node:fs/promises');
   if(args.cacheFile)try{const st=await fs.stat(args.cacheFile);if(st.size<8*1024*1024){const saved=JSON.parse(await fs.readFile(args.cacheFile,'utf8'));if(saved.version===1&&saved.home===args.home&&Array.isArray(saved.entries))core.seedScanCache(saved.entries.filter(e=>Array.isArray(e)&&e.length===2&&typeof e[0]==='string'&&typeof e[1]?.signature==='string'&&((e[1].session?.file===e[0]&&typeof e[1].session?.id==='string'&&/^[a-f0-9]{64}$/.test(e[1].session?.digest)&&Array.isArray(e[1].session?.messages))||(e[1].issue?.kind==='oversized'&&typeof e[1].issue?.message==='string'))));}}catch{}
   const result=await core.scan(args.home,{previewLimit:0,onProgress:progress,threadIds:args.threadIds,metadataOnly:args.metadataOnly});
   if(args.cacheFile)try{await core.atomic(args.cacheFile,JSON.stringify({version:1,home:args.home,entries:core.exportScanCache()}));}catch{}
   return result;
  }
  throw Error('Unknown synchronization task');
 })().then(result=>parentPort.postMessage({result,scanCache:require('./core.cjs').exportScanCache()}),error=>parentPort.postMessage({error:error.message}));
}
function run(task,args,onProgress=()=>{}){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(__filename,{execArgv:[],workerData:{task,args,scanCache:['scan','receive'].includes(task)?require('./core.cjs').exportScanCache():[]},resourceLimits:{maxOldGenerationSizeMb:192}});let settled=false;
  worker.on('message',message=>{if(message.progress){onProgress(message.progress);return;}settled=true;if(message.scanCache)require('./core.cjs').seedScanCache(message.scanCache);message.error?reject(Error(message.error)):resolve(message.result);});
  worker.once('error',error=>{settled=true;reject(Error('接收工作线程停止：'+error.message+'。请保留备份和恢复报告，不要重复覆盖。'));});
  worker.once('exit',code=>{if(!settled)reject(Error('接收工作线程提前退出（'+code+'）。请保留备份与恢复锁，检查恢复报告。'));});
 });
}
module.exports={run};
