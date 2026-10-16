(function(){
  function rows(text){
    const lines=text.split('\n'),out=[];let left=0,right=0;
    for(let i=0;i<lines.length;i++){
      const line=lines[i],match=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if(/^(diff --git |index |--- |\+\+\+ |Binary files )/.test(line)){if(line.startsWith('diff --git ')){left=0;right=0;}out.push({header:line});continue;}
      if(match){left=+match[1];right=+match[2];out.push({header:line});continue;}
      if(!left&&!right){out.push({header:line});continue;}
      if(line.startsWith('-')||line.startsWith('+')){
        const removed=[],added=[];
        while(i<lines.length&&/^[+-]/.test(lines[i])&&!/^--- |^\+\+\+ /.test(lines[i])){const value=lines[i++];(value[0]==='-'?removed:added).push(value.slice(1));}i--;
        for(let n=0;n<Math.max(removed.length,added.length);n++)out.push({left:removed[n],right:added[n],leftNumber:removed[n]!==undefined?left++:null,rightNumber:added[n]!==undefined?right++:null,changed:true});
      }else if(line.startsWith(' '))out.push({left:line.slice(1),right:line.slice(1),leftNumber:left++,rightNumber:right++});
      else out.push({header:line});
    }
    return out;
  }
  function render(target,text){
    target.replaceChildren();
    if(!text.startsWith('diff --git')){const pre=document.createElement('pre');pre.textContent=text;target.append(pre);return;}
    const table=document.createElement('table');table.className='diffTable';const heading=document.createElement('tr');for(const title of ['旧行','原内容','新行','新内容']){const cell=document.createElement('th');cell.textContent=title;heading.append(cell);}table.append(heading);
    for(const row of rows(text)){const tr=document.createElement('tr');if(row.header!==undefined){const td=document.createElement('td');td.colSpan=4;td.textContent=row.header;td.className='diffMeta';tr.append(td);}else{for(const [value,cls]of [[row.leftNumber,'lineNo'],[row.left,row.changed&&row.left!==undefined?'removed':''],[row.rightNumber,'lineNo'],[row.right,row.changed&&row.right!==undefined?'added':'']]){const td=document.createElement('td');td.textContent=value??'';td.className=cls;tr.append(td);}}table.append(tr);}target.append(table);
  }
  if(typeof module!=='undefined')module.exports={rows};else window.renderGitDiff=render;
})();
