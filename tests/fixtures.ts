import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'control-center-test-'));
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  async function repo(name: string, commit = true) {
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    git(directory, 'init', '-b', 'main');
    if (commit) {
      await writeFile(path.join(directory, 'README.md'), '# Fixture\n');
      git(directory, 'add', 'README.md');
      git(
        directory,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Initial fixture',
      );
    }
    return directory;
  }
  return { root, repo, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}
