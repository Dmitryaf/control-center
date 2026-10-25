import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { SourceSelection, emptySelection } from './SourceSelection';

afterEach(cleanup);
for (const projectId of [null, 'project-one']) {
  test(`core sources include current review text with editable consent: ${projectId ?? 'general'}`, async () => {
    function Form() {
      const [value, setValue] = useState({
        ...emptySelection(projectId),
        projectIds: ['project-one'],
      });
      return (
        <>
          <SourceSelection value={value} onChange={setValue} projects={[]} projectId={projectId} />
          <output>{JSON.stringify(value)}</output>
        </>
      );
    }
    render(<Form />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Выбрать основной набор' }));
    const selection = () => JSON.parse(screen.getByRole('status').textContent!);
    expect(selection()).toMatchObject({
      projectIds: ['project-one'],
      includeUserText: true,
      includeGeneral: false,
      codexDigestIds: [],
      includeRelatedAnalyses: false,
    });
    expect(selection().sourceKinds).not.toContain('file_decision');
    await user.click(screen.getByText('Настроить источники'));
    await user.click(screen.getByLabelText('Мой сохранённый текст этого обзора'));
    expect(selection().includeUserText).toBe(false);
  });
}
