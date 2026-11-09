import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis } from 'lucide-react';
import type { ReactNode } from 'react';

export function ActionMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="action-menu-trigger" aria-label={label} title={label}>
          <Ellipsis size={19} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="action-menu"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            // An action may already have moved focus into the form it opened.
            const focused = document.activeElement;
            if (focused && focused !== document.body && !focused.closest('[role="menu"]')) {
              event.preventDefault();
            }
          }}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export const ActionMenuItem = DropdownMenu.Item;
