// Minimal producer schema for the fields the reader relies on, including the
// safety-critical state-DB-only flag. Runtime responses are checked separately.
export const protocolScript = `
if(process.argv.includes('--version')){console.log('codex-cli 2.42.7');process.exit();}
if(process.argv.includes('generate-json-schema')) {
  const fs=require('node:fs'),path=require('node:path');
  const d=process.argv[process.argv.indexOf('--out')+1];
  fs.mkdirSync(path.join(d,'v2'));
  fs.writeFileSync(path.join(d,'ClientRequest.json'),JSON.stringify({oneOf:['initialize','thread/list','thread/read','thread/turns/list','thread/items/list'].map(method=>({properties:{method:{enum:[method]}}}))}));
  for(const [name,fields] of Object.entries({ThreadListParams:['cwd','useStateDbOnly','cursor','limit'],ThreadReadParams:['threadId','includeTurns'],ThreadTurnsListParams:['threadId','itemsView','sortDirection','cursor'],ThreadItemsListParams:['threadId','turnId','cursor']}))
    fs.writeFileSync(path.join(d,'v2',name+'.json'),JSON.stringify({properties:Object.fromEntries(fields.map(f=>[f,{}]))}));
  process.exit();
}
`;
