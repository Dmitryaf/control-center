import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { designFixture } from './design-fixture';

// DOM and interaction contracts; screenshots are inputs for manual review only.
test('project shows paused-only unfinished checks and keeps completed checks in the archive', async ({
  page,
}) => {
  const data = designFixture();
  const paused = { ...data.checks[0]!, status: 'paused' as const, signals: [] };
  const completed = {
    ...data.checks[1]!,
    status: 'completed' as const,
    completedAt: '2026-10-04',
    signals: [],
  };
  data.checks = [paused, completed];
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await page.route('**/api/projects/project-0', (route) =>
    route.fulfill({ json: data.projects[0] }),
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/projects/project-0');
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Проверки проекта', exact: true }) });
    await expect(section).toBeVisible();
    await expect(section.locator('.check-card')).toHaveCount(1);
    await expect(section.getByRole('link', { name: paused.title, exact: true })).toBeVisible();
    await expect(section.locator('.clock-state')).toHaveText('На паузе');
    await expect(page.getByRole('link', { name: completed.title, exact: true })).toHaveCount(0);
  }
  await page.goto('/checks');
  await page.getByRole('button', { name: /Архив/ }).click();
  await expect(page.getByRole('link', { name: completed.title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: paused.title, exact: true })).toHaveCount(0);
});

test('horizontal navigation stays reachable and identifies the current section at five widths', async ({
  page,
}) => {
  const data = designFixture();
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await mkdir('.local/post-design-review', { recursive: true });
  const metrics = [];
  for (const width of [1440, 1100, 800, 550, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/checks');
    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    const links = nav.getByRole('link');
    await expect(links).toHaveCount(7);
    for (let index = 0; index < 7; index++) {
      const link = links.nth(index);
      await expect(link).toBeVisible();
      const href = await link.getAttribute('href');
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${href === '/' ? '/' : href}$`));
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(link).toHaveClass(/selected/);
      await expect(page.locator('h1')).toBeVisible();
    }
    await page.goto('/checks');
    await expect(nav.getByRole('link', { name: 'Проверки', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const geometry = await page.locator('.workspace-bar').evaluate((bar) => {
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          right: bounds.right,
          bottom: bounds.bottom,
          height: bounds.height,
        };
      };
      const brand = rect(bar.querySelector('.brand')!);
      const refresh = rect(bar.querySelector('button')!);
      const anchors = [...bar.querySelectorAll('nav a')].map((anchor) => {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        return { ...rect(anchor), textLines: range.getClientRects().length };
      });
      const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
        a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
      return {
        width: innerWidth,
        height: rect(bar).height,
        rows: new Set(anchors.map((anchor) => Math.round(anchor.y))).size,
        textLines: anchors.map((anchor) => anchor.textLines),
        overlap:
          overlap(brand, refresh) ||
          anchors.some(
            (anchor, index) =>
              overlap(anchor, brand) ||
              overlap(anchor, refresh) ||
              anchors.slice(index + 1).some((other) => overlap(anchor, other)),
          ),
        clipped: [brand, refresh, ...anchors].some((item) => item.x < 0 || item.right > innerWidth),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.overlap).toBe(false);
    expect(geometry.clipped).toBe(false);
    expect(geometry.overflow).toBe(false);
    expect(geometry.textLines).toEqual(Array(7).fill(1));
    metrics.push(geometry);
    await page
      .locator('.workspace-bar')
      .screenshot({ path: `.local/post-design-review/navigation-${width}.png` });
    await page.screenshot({ path: `.local/post-design-review/checks-${width}.png` });
  }
  await writeFile(
    '.local/post-design-review/navigation-metrics.json',
    JSON.stringify(metrics, null, 2),
  );
});

test('long project heading does not squeeze its action into broken words with enlarged text', async ({
  page,
}) => {
  const data = designFixture();
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await page.route('**/api/projects/project-0', (route) =>
    route.fulfill({ json: data.projects[0] }),
  );
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto('/projects/project-0');
  const edit = page.getByRole('button', { name: 'Изменить сводку', exact: true });
  await expect(edit).toBeVisible();
  // A bounded action-layout check, not a general text-readability assertion.
  await page.evaluate(() => {
    const styles = [...document.querySelectorAll<HTMLElement>('body, body *')].map((element) => {
      const style = getComputedStyle(element);
      return { element, size: parseFloat(style.fontSize), height: parseFloat(style.lineHeight) };
    });
    for (const { element, size, height } of styles) {
      element.style.fontSize = `${size * 2}px`;
      if (Number.isFinite(height)) element.style.lineHeight = `${height * 2}px`;
    }
  });
  const lines = await edit.evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    return range.getClientRects().length;
  });
  expect(lines).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Сводка проекта', exact: true })).toBeVisible();
});
