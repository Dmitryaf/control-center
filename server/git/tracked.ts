import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The index, including staged changes, is the publication candidate. Never infer from disk.
export async function trackedFiles(directory: string): Promise<string[]> {
  const result = await promisify(execFile)(
    'git',
    [
      '--no-optional-locks',
      '--no-pager',
      '-c',
      'core.fsmonitor=false',
      '-C',
      directory,
      'ls-files',
      '-z',
      '--cached',
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}
