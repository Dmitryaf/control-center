import test from 'node:test';
import assert from 'node:assert/strict';
import { violations, checkTree } from '../scripts/check-boundaries.js';
test('actual source tree respects boundaries', () =>
  assert.deepEqual(checkTree(process.cwd()), []));
test('TSX and React imports obey the same runtime boundaries', () => {
  assert.equal(
    violations('src/features/tasks/a.tsx', 'import fs from "node:fs"; const x = <div/>;').length,
    1,
  );
  assert.equal(violations('shared/a.ts', 'import {useState} from "react"').length, 1);
  assert.equal(violations('shared/a.ts', 'import {createRoot} from "react-dom/client"').length, 1);
  assert.equal(violations('src/shared/a.tsx', 'export {A} from "../features/A"').length, 1);
  assert.equal(violations('src/shared/a.tsx', 'export {default} from "../App"').length, 1);
  assert.deepEqual(
    violations(
      'src/features/tasks/a.tsx',
      'import type {Project} from "../../../../shared/contracts"; const x = <div/>;',
    ),
    [],
  );
});
test('guard permits contract imports and rejects backend, Node, reexports and dynamic imports', () => {
  assert.deepEqual(
    violations('src/features/a.ts', "import type {Project} from '../../shared/contracts'"),
    [],
  );
  assert.equal(
    violations('src/features/a.ts', "export { Store } from '../../server/db'").length,
    1,
  );
  assert.equal(violations('src/features/a.ts', "const fs = await import('node:fs')").length, 1);
  assert.equal(violations('shared/a.ts', "import {ref} from 'vue'").length, 1);
  assert.equal(violations('src/shared/a.ts', "import x from '../features/tasks/Tasks'").length, 1);
});
