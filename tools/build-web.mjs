// 웹 화면 묶기: web/src/main.ts → dist/web/app.js. --watch면 고칠 때마다 다시 묶음.
import {context,build} from 'esbuild';
const opts={entryPoints:['web/src/main.ts'],outfile:'dist/web/app.js',bundle:true,format:'esm',target:'es2020',sourcemap:true,logLevel:'info'};
if(process.argv.includes('--watch')){const c=await context(opts);await c.watch();}else await build({...opts,minify:true});
