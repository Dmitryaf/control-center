import { afterEach, beforeAll, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createMemoryRouter, RouterProvider, Outlet, Link, useNavigate } from 'react-router';
import { DraftProvider, UnsavedChanges } from './UnsavedChanges';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
function setup(secondDirty = false) {
  function Editor() {
    const [first, setFirst] = useState(true),
      [second, setSecond] = useState(secondDirty);
    const navigate = useNavigate();
    return (
      <>
        <UnsavedChanges dirty={first} />
        <UnsavedChanges dirty={second} />
        <Link to="/done">Leave</Link>
        <button
          onClick={() => {
            flushSync(() => setFirst(false));
            navigate('/done');
          }}
        >
          Save first
        </button>
        <button
          onClick={() => {
            flushSync(() => {
              setFirst(false);
              setSecond(false);
            });
            navigate('/done');
          }}
        >
          Save both
        </button>
      </>
    );
  }
  const router = createMemoryRouter([
    {
      element: (
        <DraftProvider>
          <Outlet />
        </DraftProvider>
      ),
      children: [
        { path: '/', element: <Editor /> },
        { path: '/done', element: <p>Saved destination</p> },
      ],
    },
  ]);
  render(<RouterProvider router={router} />);
  return userEvent.setup();
}
test('a completed save may navigate in the same tick without a stale discard prompt', async () => {
  const user = setup();
  await user.click(screen.getByRole('button', { name: 'Save first' }));
  expect(screen.getByText('Saved destination')).toBeTruthy();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
test('another independently dirty form still blocks navigation and remains registered', async () => {
  const user = setup(true);
  await user.click(screen.getByRole('link', { name: 'Leave' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Продолжить редактирование' }));
  await user.click(screen.getByRole('button', { name: 'Save first' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Продолжить редактирование' }));
  await user.click(screen.getByRole('button', { name: 'Save both' }));
  expect(screen.getByText('Saved destination')).toBeTruthy();
});
