(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.deskTime=api;})(typeof globalThis==='object'?globalThis:this,function(){
  function timestamp(value){if(typeof value==='number')return Number.isFinite(value)?(Math.abs(value)<1e12?value*1000:value):0;if(typeof value!=='string'||!value.trim())return 0;const n=Date.parse(value);return Number.isFinite(n)?n:0;}
  function zone(value='system'){if(value==='system')return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';try{new Intl.DateTimeFormat('en',{timeZone:value}).format();return value;}catch{return 'UTC';}}
  function format(value,preference='system'){const ms=timestamp(value);if(!ms)return '时间未知';const tz=zone(preference);const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} (${tz})`;}
  function newest(a,b){return timestamp(b.created)-timestamp(a.created);}
  return {timestamp,zone,format,newest};
});
