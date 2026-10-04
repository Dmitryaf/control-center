import test from 'node:test';
import assert from 'node:assert/strict';
import { violations, checkTree } from '../scripts/check-boundaries.js';
test('actual source tree respects boundaries', () =>
  assert.deepEqual(checkTree(process.cwd()), []));
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
  assert.equal(
    violations('src/shared/a.ts', "import x from '../features/tasks/Tasks.vue'").length,
    1,
  );
  assert.equal(
    violations(
      'src/features/a.vue',
      '<script setup lang="ts">import fs from "node:fs"</script><template><p /></template>',
    ).length,
    1,
  );
});
