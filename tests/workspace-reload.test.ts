import test from 'node:test';
import assert from 'node:assert/strict';
import { reload, workspace, connectionLost } from '../src/shared/api.js';
import { defaultSettings, type Workspace } from '../shared/contracts.js';

test('out-of-order workspace successes and failures preserve the latest data and connection status', async (t) => {
  const data: Workspace = {
    projects: [],
    tasks: [],
    ideas: [],
    decisions: [],
    relations: [],
    settings: defaultSettings,
    scan: { running: false, scannedAt: null, errors: [] },
    refresh: { running: false, lastAttemptAt: null, errors: [] },
    checks: [],
    checkEntries: [],
    fileDecisions: [],
    storage: { databasePath: '/example/data.sqlite' },
  };
  const requests: { resolve: (response: Response) => void; reject: (cause: Error) => void }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    () => new Promise<Response>((resolve, reject) => requests.push({ resolve, reject })),
  );
  t.after(() => {
    workspace.value = null;
    connectionLost.value = false;
  });
  const oldFailure = reload().catch((cause: Error) => cause);
  const latestSuccess = reload();
  requests[1]!.resolve(
    Response.json({ ...data, settings: { ...defaultSettings, autoRefreshMinutes: 5 } }),
  );
  await latestSuccess;
  requests[0]!.reject(new Error('Old request failed'));
  await oldFailure;
  assert.equal(workspace.value!.settings.autoRefreshMinutes, 5);
  assert.equal(connectionLost.value, false);

  const oldSuccess = reload();
  const latestFailure = reload().catch((cause: Error) => cause);
  requests[3]!.reject(new Error('Current request failed'));
  await latestFailure;
  requests[2]!.resolve(Response.json(data));
  await oldSuccess;
  assert.equal(workspace.value!.settings.autoRefreshMinutes, 5);
  assert.equal(connectionLost.value, true);
  const recovered = reload();
  requests[4]!.resolve(Response.json(data));
  await recovered;
  assert.equal(connectionLost.value, false);
  assert.equal(workspace.value!.settings.autoRefreshMinutes, 1);
});
