import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { designFixture } from './design-fixture';

// Screenshots support manual review; assertions cover DOM, geometry and interactions only.
test('journal hierarchy, time semantics, overflow and keyboard contracts', async ({ page }) => {
  const data = designFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await page.route('**/api/projects/project-*', (route) =>
    route.fulfill({ json: data.projects.find((p) => route.request().url().endsWith(p.id)) }),
  );
  await mkdir('.local/design-discovery/screenshots', { recursive: true });
  for (const width of [1440, 1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, url] of [
      ['overview', '/'],
      ['project', '/projects/project-0'],
      ['check', '/checks/check-0'],
      ['checks', '/checks'],
      ['projects', '/projects'],
    ]) {
      await page.goto(url!);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.workspace-bar')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (name === 'overview') {
        await expect(page.locator('.attention-line').first()).toHaveClass(/decision/);
        expect((await page.locator('#attention').boundingBox())!.y).toBeLessThan(
          (await page.locator('.checks-overview').boundingBox())!.y,
        );
        await expect(page.locator('.movement-clock').first()).toContainText('18');
      }
      if (name === 'project') {
        await expect(page.locator('.context-panel')).toContainText('Приватный контекст недоступен');
        await page.getByText(/Проверка публикации ·/).click();
        await expect(page.locator('.context-panel')).toContainText('.ai-rules/PROJECT_RULES.md');
      }
      if (name === 'check') {
        await expect(page.locator('.movement-clock')).toContainText('18');
        await expect(page.locator('.check-dates')).toContainText('4 окт. 2026');
        await expect(page.locator('.history-entry').first()).toHaveClass(/evidence/);
        await page
          .locator('.history-entry')
          .first()
          .getByRole('button', { name: 'Изменить', exact: true })
          .click();
        await expect(page.getByLabel('Что произошло')).toBeFocused();
        await page.getByRole('button', { name: 'Отмена', exact: true }).click();
        await page.evaluate(() => scrollTo(0, 0));
      }
      if (name === 'projects') {
        await expect(page.locator('.project-row')).toHaveCount(12);
        await expect(page.locator('.project-row').nth(1)).toContainText('Без Git');
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `.local/design-discovery/screenshots/${name}-${width}-viewport.png`,
      });
      await page.screenshot({
        path: `.local/design-discovery/screenshots/${name}-${width}.png`,
        fullPage: true,
      });
    }
  }
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['tasks', 'ideas', 'decisions', 'settings']) {
      await page.goto(`/${name}`);
      await expect(page.locator('h1')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/design-discovery/screenshots/${name}-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/checks/check-0');
  // Root-size overflow smoke only: fixed px text does not all grow. Readability needs manual review.
  await page.evaluate(() => (document.documentElement.style.fontSize = '28px'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'К содержимому' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'К содержимому' })).toHaveCSS(
    'outline-style',
    'solid',
  );
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  expect(errors).toEqual([]);
});

test('loading, disabled refresh and error recovery states are exposed', async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workspace', async (route) => {
    await waiting;
    await route.fulfill({
      status: 503,
      json: { error: 'Источник временно недоступен. Данные сохранены.' },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Загружаем рабочее пространство…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обновление…' })).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Данные сохранены');
  await page.unroute('**/api/workspace');
  await page.route('**/api/workspace', (route) => route.fulfill({ json: designFixture() }));
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(page.getByRole('heading', { name: 'Сейчас', exact: true })).toBeVisible();
});
