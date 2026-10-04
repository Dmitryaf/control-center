import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '../../shared/contracts.js';

const exec = promisify(execFile);
export async function getGitState(directory: string, present: boolean): Promise<GitState> {
  const result: GitState = {
    present,
    branch: null,
    dirty: null,
    changedFiles: null,
    remote: null,
    commits: [],
    error: null,
  };
  if (!present) return result;
  const git = async (...args: string[]) =>
    (
      await exec(
        'git',
        [
          '--no-optional-locks',
          '--no-pager',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          '-C',
          directory,
          ...args,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true,
        },
      )
    ).stdout;
  try {
    const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=normal');
    const entries = status.split('\0').filter(Boolean);
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(entries[i])) i++;
    }
    result.changedFiles = count;
    result.dirty = count > 0;
    try {
      result.branch = (await git('symbolic-ref', '--short', '-q', 'HEAD')).trim();
    } catch {
      result.branch = 'detached HEAD';
    }
    // rev-parse failure is expected only for an unborn repository; status above has already validated access.
    let hasHead = true;
    try {
      await git('rev-parse', '--verify', 'HEAD');
    } catch {
      hasHead = false;
    }
    if (hasHead) {
      const log = await git('log', '-8', '--format=%H%x00%cI%x00%s%x00');
      const fields = log.split('\0');
      for (let i = 0; i + 2 < fields.length; i += 3) {
        result.commits.push({
          hash: fields[i].trim(),
          date: fields[i + 1],
          subject: fields[i + 2],
        });
      }
    }
    const remotes = (await git('remote')).trim().split(/\r?\n/).filter(Boolean);
    if (remotes.length) {
      const remote = (
        await git('remote', 'get-url', remotes.includes('origin') ? 'origin' : remotes[0])
      ).trim();
      // Do not expose credentials embedded in HTTPS remote URLs.
      result.remote = remote.replace(/(https?:\/\/)[^/@]+@/i, '$1').replace(/[?#].*$/, '');
    }
  } catch {
    result.error = 'Не удалось прочитать Git. Проверьте доступ к каталогу и установку Git.';
  }
  return result;
}
