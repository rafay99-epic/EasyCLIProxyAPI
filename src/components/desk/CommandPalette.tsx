// ⌘K palette: jump to any page or settings section, open an account, or run an action.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useDialogFocusTrap } from '../useDialogFocusTrap';

export type Command = { id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const ref = useDialogFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((command) => {
      const text = `${command.label} ${command.hint ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [commands, query]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setIndex((current) => (current + step + matches.length) % Math.max(1, matches.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(matches[index]);
    }
  };

  return (
    <>
      <div className="d-scrim d-cmdk-scrim" onClick={onClose} />
      <div ref={ref} className="d-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          value={query}
          placeholder="Go to, search accounts, run an action"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="d-cmdk-list"
          aria-activedescendant={matches[index] ? `d-cmdk-${matches[index].id}` : undefined}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <ul id="d-cmdk-list" ref={listRef} role="listbox">
          {matches.map((command, position) => (
            <li key={command.id}>
              <button
                id={`d-cmdk-${command.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                data-index={position}
                aria-selected={position === index}
                onMouseMove={() => setIndex(position)}
                onClick={() => run(command)}
              >
                {command.label}
                {command.hint ? <span>{command.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {!matches.length ? <div className="d-empty">Nothing matches</div> : null}
      </div>
    </>
  );
}
