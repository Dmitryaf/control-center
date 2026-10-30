import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { LocalCodexExecutor, CodexExecutionError } from '../server/codex/execution.js';
import { analysisProfile } from '../server/codex/analysis-profile.js';

const script = `
const fs=require('node:fs');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const args=process.argv.slice(3);
if(args.includes('--version')) {console.log('codex-cli fixture');process.exit(0);}
if(args.includes('--help')) {console.log('--ignore-user-config --ephemeral --output-schema --json --sandbox');process.exit(0);}
if(args.includes('features')) {args.forEach((v,i)=>{if(v==='--disable')console.log(args[i+1]+' stable false');});process.exit(0);}
if(args.includes('login')) {
 if(config.loginFixture) {
  if(args.includes('status')) process.exit(fs.existsSync(config.signedIn)?0:1);
  fs.writeFileSync(config.loginMarker,JSON.stringify({args,home:process.env.CODEX_HOME,secret:process.env.OPENAI_API_KEY||null}));
  console.log('https://auth.openai.com/codex/device');
  console.log('ABCD-EFGH');
  if(config.loginMode==='fail') {console.error('PRIVATE_AUTH_ERROR');process.exit(7);}
  setInterval(()=>{ if(fs.existsSync(config.signedIn)) process.exit(0); },25); return;
 }
 process.exit(0);
}
const emit=value=>console.log(JSON.stringify(value));
let text=''; process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>text+=chunk);
process.stdin.on('end',()=>{
 fs.writeFileSync(config.marker,JSON.stringify({args,cwd:process.cwd(),prompt:text,secret:process.env.OPENAI_API_KEY||process.env.TEST_PRIVATE_TOKEN||null,schema:JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}));
 console.error('PRIVATE_DIAGNOSTIC_DO_NOT_EXPOSE');
 emit({type:'thread.started',thread_id:'fixture-execution'});emit({type:'turn.started'});
 if(config.mode==='wait'){setInterval(()=>{},1000);return;}
 if(config.mode==='malformed'){console.log('not-json');return;}
 if(config.mode==='tool'){emit({type:'item.started',item:{type:'command_execution',command:'must-not-run'}});return;}
 emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(config.report)}});
 if(config.mode!=='incomplete') emit({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}});
});
`;
test('Codex execution uses an isolated process, filtered environment, schema and completed JSONL response', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const program = path.join(f.root, 'fake-codex.cjs'),
    config = path.join(f.root, 'config.json'),
    marker = path.join(f.root, 'observed.json');
  await writeFile(program, script);
  const report = { narrative: 'Saved output', findings: [], uncertainties: [], proposals: [] };
  await writeFile(config, JSON.stringify({ marker, report, mode: 'success' }));
  const executor = new LocalCodexExecutor(process.execPath, [program, config], {
    ...process.env,
    CONTROL_CENTER_DATA_DIR: f.root,
    OPENAI_API_KEY: 'PRIVATE_DO_NOT_FORWARD',
    TEST_PRIVATE_TOKEN: 'PRIVATE_DO_NOT_FORWARD',
  });
  assert.equal((await executor.probe()).available, true);
  const result = await executor.execute({
    prompt: 'synthetic approved packet',
    model: null,
    signal: new AbortController().signal,
    onProgress() {},
  });
  assert.deepEqual(JSON.parse(result.output), report);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8 });
  const captured = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(captured.secret, null);
  assert.equal(captured.prompt, 'synthetic approved packet');
  assert.equal(captured.args.includes('memories'), true);
  assert.ok(captured.args.includes('--ignore-user-config'));
  assert.ok(captured.args.includes('--ephemeral'));
  assert.equal(captured.args[captured.args.indexOf('--sandbox') + 1], 'read-only');
  for (const flag of ['shell_tool', 'apps', 'plugins', 'hooks', 'computer_use', 'browser_use']) {
    const i = captured.args.indexOf(flag);
    assert.equal(captured.args[i - 1], '--disable');
  }
  assert.equal(captured.schema.type, 'object');
  assert.ok(captured.schema.properties.narrative);
  await assert.rejects(access(captured.cwd), { code: 'ENOENT' });
});

test('dedicated Codex login is explicit, idempotent, cancellable and never inherits the main profile', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const program = path.join(f.root, 'login.cjs'),
    config = path.join(f.root, 'login.json');
  const marker = path.join(f.root, 'login-observed.json');
  const env = {
    ...process.env,
    CONTROL_CENTER_DATA_DIR: f.root,
    CODEX_HOME: path.join(f.root, 'personal-home'),
    OPENAI_API_KEY: 'PRIVATE_MAIN_KEY',
  };
  await writeFile(program, script);
  await writeFile(
    config,
    JSON.stringify({
      loginFixture: true,
      loginMarker: marker,
      signedIn: path.join(f.root, 'signed-in'),
    }),
  );
  const executor = new LocalCodexExecutor(process.execPath, [program, config], env);
  t.after(() => executor.cancelLogin());
  const status = await executor.probe();
  assert.equal(status.authenticated, false);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await assert.rejects(
    executor.execute({
      prompt: 'not sent',
      model: null,
      signal: new AbortController().signal,
      onProgress() {},
    }),
    /Войдите/,
  );
  await Promise.all([executor.login(), executor.login()]);
  for (let i = 0; i < 80 && (await executor.probe()).login?.state !== 'waiting'; i++)
    await new Promise((r) => setTimeout(r, 25));
  assert.equal((await executor.probe()).login?.code, 'ABCD-EFGH');
  const observed = JSON.parse(await readFile(marker, 'utf8'));
  assert.deepEqual(observed.args, ['login', '--device-auth']);
  assert.equal(observed.home, analysisProfile(env));
  assert.equal(observed.secret, null);
  await executor.cancelLogin();
  assert.equal((await executor.probe()).login, null);
  await executor.login();
  await writeFile(path.join(f.root, 'signed-in'), 'synthetic login complete');
  for (let i = 0; i < 80 && !(await executor.probe()).authenticated; i++)
    await new Promise((r) => setTimeout(r, 25));
  assert.equal((await executor.probe()).authenticated, true);
  assert.equal((await executor.probe()).login, null);
  await writeFile(path.join(analysisProfile(env), 'AGENTS.md'), 'private injected guidance');
  const guarded = new LocalCodexExecutor(process.execPath, [program, config], env);
  assert.equal((await guarded.probe()).available, false);
  assert.match((await guarded.probe()).reason!, /AGENTS.md/);
});
test('Codex rejects incomplete/malformed/tool events and stops only its own process on cancellation', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const program = path.join(f.root, 'fake-codex.cjs'),
    config = path.join(f.root, 'config.json'),
    marker = path.join(f.root, 'observed.json');
  await writeFile(program, script);
  const executor = new LocalCodexExecutor(process.execPath, [program, config], {
    ...process.env,
    CONTROL_CENTER_DATA_DIR: f.root,
  });
  for (const mode of ['incomplete', 'malformed', 'tool', 'wait']) {
    await writeFile(
      config,
      JSON.stringify({
        marker,
        report: { narrative: 'not accepted', findings: [], uncertainties: [], proposals: [] },
        mode,
      }),
    );
    const controller = new AbortController();
    const result = executor.execute({
      prompt: 'synthetic packet',
      model: null,
      signal: controller.signal,
      onProgress(stage) {
        if (mode === 'wait' && stage.includes('анализирует')) controller.abort();
      },
    });
    await assert.rejects(
      result,
      (error) =>
        error instanceof CodexExecutionError && !error.message.includes('PRIVATE_DIAGNOSTIC'),
    );
  }
});
