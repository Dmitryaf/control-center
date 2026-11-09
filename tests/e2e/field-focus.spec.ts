import { test, expect, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('field focus stays inside compact controls while keyboard actions remain visible', async ({
  page,
}) => {
  await mkdir('.local/work/cc-16-focus', { recursive: true });
  async function containedFocus(field: Locator, indicator = field) {
    await expect(field).toBeFocused();
    const focus = await indicator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
        outside: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
      };
    });
    expect.soft(focus.visible).toBe(true);
    expect.soft(focus.outside).toBeLessThanOrEqual(0);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/tasks');
    const title = page.getByRole('textbox', { name: 'Название задачи', exact: true });
    await title.click();
    await page.screenshot({ path: `.local/work/cc-16-focus/tasks-${width}.png` });
    await containedFocus(title, page.locator('.task-entry'));
    await expect(title).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    const parameters = page.getByRole('button', { name: 'Параметры задачи', exact: true });
    await expect(parameters).toBeFocused();
    expect(await parameters.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    const description = page.getByRole('textbox', { name: 'Описание', exact: true });
    await description.click();
    await containedFocus(description);
    await page.goto('/analysis');
    const question = page.getByRole('textbox', { name: 'Что хотите обсудить?', exact: true });
    await question.click();
    await page.screenshot({ path: `.local/work/cc-16-focus/analysis-${width}.png` });
    await containedFocus(question);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
