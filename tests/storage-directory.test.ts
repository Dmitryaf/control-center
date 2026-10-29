import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { dataDirectory } from '../server/storage.js';

test('Windows storage is shared across launch environments and refuses an empty legacy replacement', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const profile = path.join(f.root, 'profile');
  const desktop = path.join(f.root, 'desktop-local');
  const packaged = path.join(f.root, 'packaged-local');
  const stable = path.join(profile, '.control-center');
  const desktopEnv = { USERPROFILE: profile, LOCALAPPDATA: desktop };
  const packagedEnv = { USERPROFILE: profile, LOCALAPPDATA: packaged };
  assert.equal(dataDirectory(desktopEnv, 'win32', f.root), stable);
  assert.equal(dataDirectory(packagedEnv, 'win32', f.root), stable);
  const legacy = path.join(desktop, 'ControlCenter');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'control-center.sqlite'), 'existing database sentinel');
  assert.throws(() => dataDirectory(desktopEnv, 'win32', f.root), /Пустая база не создана/);
  await assert.rejects(access(stable));
  assert.equal(
    dataDirectory({ ...desktopEnv, CONTROL_CENTER_DATA_DIR: legacy }, 'win32', f.root),
    legacy,
  );
  await mkdir(stable, { recursive: true });
  await writeFile(path.join(stable, 'control-center.sqlite'), 'selected database sentinel');
  assert.equal(dataDirectory(desktopEnv, 'win32', f.root), stable);
  assert.equal(dataDirectory(packagedEnv, 'win32', f.root), stable);
});
