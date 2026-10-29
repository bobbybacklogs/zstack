import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ZStack} from '../src/sdk.mjs';
import {startServer,stopServer} from '../src/serve.mjs';
let kitInstalled = true;
try { await import('@cass/mh-kit/web-agent'); } catch { kitInstalled = false; }
const result={id:'zstack-test',model:'modelhitch/auto',answer:'Researched https://nodejs.org/en',toolCalls:[{name:'web_search',ok:true},{name:'read_page',ok:true}]};
test('zStack authenticated research API/SDK/CLI use only its private app key and prompt',async t=>{
 const oldKey=process.env.MH_AGENT_API_KEY,oldURL=process.env.MH_AGENT_URL;
 const calls=[];
 const upstream=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer synthetic-zstack-app-key');
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/agent/health'){res.end(JSON.stringify({ok:true,model:'modelhitch/auto',tools:['web_search','read_page']}));return;}
  let body='';for await(const chunk of req)body+=chunk;calls.push(JSON.parse(body));assert.deepEqual(Object.keys(JSON.parse(body)),['prompt']);res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 process.env.MH_AGENT_API_KEY='synthetic-zstack-app-key';process.env.MH_AGENT_URL=`http://127.0.0.1:${upstream.address().port}/v1/agent/run`;
 const dir=await mkdtemp(join(tmpdir(),'zstack-web-'));
 const app=await startServer({port:0,zstack:new ZStack(),apiToken:'operator-token',requireAuth:true,enableScheduler:false,historyPath:join(dir,'history.jsonl'),projectsPath:join(dir,'projects.json'),overridesPath:join(dir,'overrides.json'),keysPath:join(dir,'keys.json')});
 t.after(async()=>{await stopServer(app);await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});if(oldKey===undefined)delete process.env.MH_AGENT_API_KEY;else process.env.MH_AGENT_API_KEY=oldKey;if(oldURL===undefined)delete process.env.MH_AGENT_URL;else process.env.MH_AGENT_URL=oldURL;});
 const request=(body,token='operator-token',origin)=>fetch(app.url+'api/research',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
 assert.equal((await request({prompt:'hello'},'wrong')).status,401);
 assert.equal((await request({prompt:'hello'},'synthetic-zstack-app-key')).status,401);
 assert.equal((await request({prompt:'hello'},'operator-token','https://other.test')).status,403);
 for(const body of [{prompt:''},{prompt:'hello',model:'different'},{prompt:'hello',tools:['read_file']},{prompt:'hello',apiKey:'different'},{prompt:'hello',endpoint:'http://127.0.0.1'}])assert.equal((await request(body)).status,400);
 assert.equal(calls.length,0);
 if (!kitInstalled) {
  const missing=await request({prompt:'research'});assert.equal(missing.status,503);assert.equal(calls.length,0);
  const health=await fetch(app.url+'api/research',{headers:{authorization:'Bearer operator-token'}});assert.equal(health.status,503);
  return;
 }
 const response=await request({prompt:'research'});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{ok:true,...result});
 const health=await fetch(app.url+'api/research',{headers:{authorization:'Bearer operator-token'}});assert.equal(health.status,200);assert.deepEqual((await health.json()).tools,['web_search','read_page']);
 const cli=await promisify(execFile)(process.execPath,['bin/zstack.mjs','research','research','--json'],{cwd:new URL('..',import.meta.url),env:process.env});assert.equal(JSON.parse(cli.stdout).answer,result.answer);
 assert.equal(calls.length,2);
});

test('core commands work without research configuration and missing private client fails explicitly',async t=>{
 const {readFile,writeFile}=await import('node:fs/promises');
 const {pathToFileURL}=await import('node:url');
 const dir=await mkdtemp(join(tmpdir(),'zstack-no-kit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // A standalone module outside this repository has no optional client to resolve.
 await writeFile(join(dir,'web-agent.mjs'),await readFile(new URL('../src/web-agent.mjs',import.meta.url)));
 const standalone=await import(pathToFileURL(join(dir,'web-agent.mjs')));
 const old=process.env.MH_AGENT_API_KEY;
 try {
  process.env.MH_AGENT_API_KEY='synthetic-only';
  await assert.rejects(standalone.runWebResearch('hello'),e=>e.code==='config'&&e.message.includes('optional private MH Kit'));
  delete process.env.MH_AGENT_API_KEY;
  await assert.rejects(standalone.webResearchHealth(),e=>e.code==='config'&&e.message.includes('MH_AGENT_API_KEY'));
 } finally {if(old===undefined)delete process.env.MH_AGENT_API_KEY;else process.env.MH_AGENT_API_KEY=old;}
 const cli=await promisify(execFile)(process.execPath,['bin/zstack.mjs','version','--json'],{cwd:new URL('..',import.meta.url)});
 assert.equal(JSON.parse(cli.stdout).ok,true);
});
