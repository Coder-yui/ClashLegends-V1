import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useLayoutEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal game-dialog"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        className="cross"
        aria-label="关闭"
        data-cue="back"
        onClick={onClose}
      >
        ×
      </button>
      <h2 id={id}>{title}</h2>
      {children}
    </dialog>
  );
}
export function useConfirmation() {
  const [request, setRequest] = useState<{
    title: string;
    message: string;
    accept: string;
  } | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  useEffect(() => () => resolver.current?.(false), []);
  const ask = useCallback(
    (title: string, message: string, accept: string) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setRequest({ title, message, accept });
      }),
    [],
  );
  function finish(answer: boolean) {
    resolver.current?.(answer);
    resolver.current = null;
    setRequest(null);
  }
  return {
    ask,
    confirmation: request && (
      <Modal title={request.title} onClose={() => finish(false)}>
        <p>{request.message}</p>
        <div className="footer-actions">
          <button autoFocus onClick={() => finish(false)}>
            取消
          </button>
          <button className="gold" onClick={() => finish(true)}>
            {request.accept}
          </button>
        </div>
      </Modal>
    ),
  };
}
type Item = { id: string; name: string };
export function Choice({
  label,
  value,
  items,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  items: Item[];
  onChange: (id: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  const selected = items.findIndex((x) => x.id === value);
  function toggle() {
    setActive(Math.max(0, selected));
    setOpen(!open);
  }
  function choose(i: number) {
    if (!items[i]) return;
    setOpen(false);
    trigger.current?.focus();
    onChange(items[i].id);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(id + "-" + active)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);
  return (
    <div
      className="choice"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      {!compact && <span className="field-label">{label}</span>}
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? id + "-" + active : undefined}
        ref={trigger}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key === "Tab") {
            setOpen(false);
            return;
          }
          if (open && ["Enter", " "].includes(e.key)) {
            e.preventDefault();
            choose(active);
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
            const base = open ? active : Math.max(0, selected);
            setActive(
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        items.length - 1,
                        base + (e.key === "ArrowDown" ? 1 : -1),
                      ),
                    ),
            );
          }
        }}
      >
        {items[selected]?.name ?? "请选择"} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="choice-list" role="listbox" id={id} aria-label={label}>
          {items.map((item, i) => (
            <button
              type="button"
              tabIndex={-1}
              key={item.id}
              id={id + "-" + i}
              data-value={item.id}
              role="option"
              aria-selected={selected === i}
              className={active === i ? "highlight" : ""}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              {item.name}
              {selected === i && <span aria-hidden="true"> ✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline list for browsing larger catalogs without opening a system picker.
export function ChoiceList({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: (Item & { bound?: boolean })[];
  onChange: (id: string) => void;
}) {
  const selected = items.findIndex((item) => item.id === value);
  return (
    <div
      role="listbox"
      aria-label={label}
      className="game-list"
      onKeyDown={(e) => {
        const current = items.findIndex((item) => item.id === value);
        const next =
          e.key === "ArrowDown"
            ? current + 1
            : e.key === "ArrowUp"
              ? current - 1
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : undefined;
        if (next === undefined || !items.length) return;
        e.preventDefault();
        const index = Math.max(0, Math.min(next, items.length - 1));
        (e.currentTarget.children[index] as HTMLElement).focus();
        onChange(items[index].id);
      }}
    >
      {items.map((item, i) => (
        <button
          type="button"
          role="option"
          key={item.id}
          data-value={item.id}
          data-bound={item.bound}
          tabIndex={value === item.id || (selected < 0 && i === 0) ? 0 : -1}
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.name}
        </button>
      ))}
    </div>
  );
}
