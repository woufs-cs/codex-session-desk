'use strict';
const fs=require('node:fs');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
// An active large transfer must not expire merely because five minutes elapsed.
async function transfer({url,headers={},source,target,maxBytes,onProgress=()=>{},stage='传输'}, {request=require('node:https').request,idleMs=120000,totalMs=7200000}={}) {
 const uploading=!!source,total=uploading?(await fs.promises.stat(source)).size:undefined;
 if(total>maxBytes)throw Error(`${stage}：对象超过大小限制`);
 let req,res,input,output,idle,deadline,current=0,last=0,expected=total,settled=false;
 const emit=(complete=false)=>{const now=Date.now();if(!complete&&now-last<100)return;last=now;onProgress({stage,current,total:expected,unit:'bytes',complete});};
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(idle);clearTimeout(deadline);};
  const fail=error=>{if(settled)return;settled=true;cleanup();const e=new Error(`${stage}：${error.message}`,{cause:error});e.status=error.status;e.code=error.code;
   // Windows cannot remove the staging file until its stream handle closes.
   const closed=[input,output].filter(s=>s&&!s.closed).map(s=>new Promise(resolve=>s.once('close',resolve)));
   req?.destroy();res?.destroy();input?.destroy();output?.destroy();Promise.all(closed).then(()=>reject(e));};
  const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>fail(Error(`连续 ${idleMs/1000} 秒没有传输进展或服务器响应，请检查网络后重试`)),idleMs);};
  const counter=()=>new Transform({transform(chunk,encoding,callback){current+=chunk.length;if(current>maxBytes){callback(Error('对象超过大小限制'));return;}touch();emit();callback(null,chunk);}});
  const finish=()=>{if(settled)return;settled=true;cleanup();emit(true);resolve();};
  touch();deadline=setTimeout(()=>fail(Error('传输超过两小时上限，请检查连接后重试')),totalMs);
  try{
   onProgress({stage,current:0,total:expected,unit:'bytes'});
   req=request(url,{method:uploading?'PUT':'GET',headers:{...headers,...(uploading?{'Content-Length':total}:{})}},async response=>{
    res=response;res.on('error',fail);touch();
    if(res.statusCode<200||res.statusCode>=300){const e=Error(`HTTP ${res.statusCode}`);e.status=res.statusCode;fail(e);return;}
    try{
     if(uploading){if(current!==total)throw Error('服务端在上传完成前返回响应');res.resume();res.once('end',finish);return;}
     const length=res.headers['content-length'];expected=length===undefined?undefined:Number(length);
     if(expected>maxBytes)throw Error('远端对象超过大小限制');
     output=fs.createWriteStream(target,{flags:'wx'});
     await pipeline(res,counter(),output);
     if(expected!==undefined&&current!==expected)throw Error('下载长度与服务端声明不一致');finish();
    }catch(e){fail(e);}
   });
   req.on('error',fail);
   if(uploading){input=fs.createReadStream(source,{highWaterMark:65536});pipeline(input,counter(),req).then(()=>{if(!settled)onProgress({stage:stage+'：等待服务器确认',current,total,unit:'bytes',complete:true});},fail);}
   else req.end();
  }catch(e){fail(e);}
 });
}
module.exports={transfer};
