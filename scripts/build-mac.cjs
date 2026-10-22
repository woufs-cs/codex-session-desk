const path=require('node:path'),{spawnSync}=require('node:child_process');
if(process.platform!=='darwin'){console.error('macOS build must run on a Mac. Use bash scripts/start-mac.sh there for source startup.');process.exit(1);}
const arch=process.argv[2]||process.arch;if(!['arm64','x64'].includes(arch)){console.error('Architecture must be arm64 or x64');process.exit(1);}
const root=path.resolve(__dirname,'..');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/out/cli/cli.js'),'--config','electron-builder.mac.json','--mac','--'+arch,'--publish','never'],{cwd:root,stdio:'inherit',env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false',NODE_OPTIONS:'--max-old-space-size=512'}});
if(result.error)console.error(result.error.message);process.exit(result.status??1);
