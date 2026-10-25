import { test, expect } from '@playwright/test';
import { designFixture } from './design-fixture';

// Synthetic responses isolate browser request amplification from SQL execution cost.
for (const count of [10, 20, 30]) {
  test(`overview request load for ${count} projects`, async ({ page }) => {
    const data = designFixture();
    data.projects = Array.from({ length: count }, (_, i) => ({
      ...data.projects[i % data.projects.length],
      id: `load-${i}`,
      metadata: { ...data.projects[0].metadata, name: `Load project ${i}` },
    }));
    data.tasks = [];
    data.checks = [];
    data.decisions = [];
    let history = 0;
    let workspace = 0;
    await page.route('**/api/workspace', (route) => {
      workspace++;
      return route.fulfill({ json: data });
    });
    await page.route('**/api/history**', (route) => {
      history++;
      return route.fulfill({
        json: {
          items: [],
          nextCursor: null,
          files: { undated: 0, unavailable: 0, notLoadedProjects: 0 },
        },
      });
    });
    const started = Date.now();
    await page.goto('/');
    await expect(page.locator('.project-row')).toHaveCount(count);
    await expect(page.getByText('Записей работы пока нет.', { exact: true })).toHaveCount(count);
    const readyMs = Date.now() - started;
    const initial = { history, workspace };
    expect(initial.history).toBe(2);
    // One actual polling interval; no fake clock changing network scheduling.
    await expect.poll(() => history, { timeout: 8000 }).toBeGreaterThan(initial.history);
    await page.waitForTimeout(500);
    expect(history - initial.history).toBe(2);
    console.log(
      JSON.stringify({ projects: count, readyMs, initial, afterPoll: { history, workspace } }),
    );
  });
}
