const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
if(!isMainThread){
 const progress=value=>parentPort.postMessage({progress:value});
 (async()=>{
  const {task,args}=workerData;require('./core.cjs').seedScanCache(workerData.scanCache);
  if(task==='receive')return require('./recovery.cjs').apply(args.rows,args.cache,args.home,args.cwd,{...args.options,onProgress:progress});
  if(task==='inspect')return require('./session-io.cjs').inspect(args.file,{previewLimit:4096});
  if(task==='scan')return require('./core.cjs').scan(args.home,{previewLimit:0,onProgress:progress});
  throw Error('Unknown synchronization task');
 })().then(result=>parentPort.postMessage({result,scanCache:require('./core.cjs').exportScanCache()}),error=>parentPort.postMessage({error:error.message}));
}
function run(task,args,onProgress=()=>{}){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(__filename,{execArgv:[],workerData:{task,args,scanCache:require('./core.cjs').exportScanCache()},resourceLimits:{maxOldGenerationSizeMb:192}});let settled=false;
  worker.on('message',message=>{if(message.progress){onProgress(message.progress);return;}settled=true;if(message.scanCache)require('./core.cjs').seedScanCache(message.scanCache);message.error?reject(Error(message.error)):resolve(message.result);});
  worker.once('error',error=>{settled=true;reject(Error('接收工作线程停止：'+error.message+'。请保留备份和恢复报告，不要重复覆盖。'));});
  worker.once('exit',code=>{if(!settled)reject(Error('接收工作线程提前退出（'+code+'）。请保留备份与恢复锁，检查恢复报告。'));});
 });
}
module.exports={run};
