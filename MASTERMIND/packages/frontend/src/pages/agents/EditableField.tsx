import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

export interface EditableFieldProps<T extends string | number> {
  value: T | undefined;
  onSave: (value: T | undefined) => Promise<void> | void;
  type?: 'text' | 'number';
  placeholder?: string;
  format?: (v: T | undefined) => ReactNode;
  parse?: (raw: string) => T | undefined;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  inputClassName?: string;
}

export function EditableField<T extends string | number>({
  value, onSave, type = 'text', placeholder, format, parse,
  min, max, step, className, inputClassName,
}: EditableFieldProps<T>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(value == null ? '' : String(value));
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draft.trim();
    let next: T | undefined;
    if (trimmed === '') {
      next = undefined;
    } else if (parse) {
      next = parse(trimmed);
    } else if (type === 'number') {
      const n = Number(trimmed);
      next = (isNaN(n) ? undefined : n) as T | undefined;
    } else {
      next = trimmed as T;
    }
    if (next === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // keep editing state open so user can retry
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => setEditing(false);

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={e => {
          if (e.key === 'Enter') void commit();
          else if (e.key === 'Escape') cancel();
        }}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        disabled={saving}
        className={inputClassName ?? `bg-secondary border border-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-ring ${saving ? 'opacity-60' : ''}`}
      />
    );
  }

  const display = format
    ? format(value)
    : value == null || value === ''
      ? <span className="text-muted-foreground/50 italic">{placeholder ?? '—'}</span>
      : String(value);

  return (
    <button
      type="button"
      onClick={startEdit}
      className={`text-left hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors ${className ?? ''}`}
      title="Cliquer pour éditer"
    >
      {display}
    </button>
  );
}
