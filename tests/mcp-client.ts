import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function connectMcp(dataDirectory: string, cwd: string, compiled = false) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({ name: 'control-center-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: compiled
      ? [path.join(root, 'dist/server/server/mcp/index.js')]
      : ['--import', import.meta.resolve('tsx'), path.join(root, 'server/mcp/index.ts')],
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      CONTROL_CENTER_DATA_DIR: dataDirectory,
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args });
    const blocks = response.content as { type: string; text?: string }[];
    const text = blocks.find((item) => item.type === 'text')!.text!;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { error: text };
    }
    return { isError: Boolean(response.isError), value };
  }
  return { client, transport, call, close: () => client.close() };
}
