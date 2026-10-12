import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/**
 * Caixa de texto que cresce conforme o texto (inclusive linhas que quebram sozinhas), como no WhatsApp,
 * até `maxHeight`; a partir daí rola por dentro.
 */
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }
>(function AutoTextarea({ maxHeight = 200, className = "", value, ...props }, ref) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const height = Math.min(el.scrollHeight + 2, maxHeight);
    el.style.height = `${height}px`;
    el.style.overflowY = el.scrollHeight + 2 > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);

  return <textarea ref={inner} rows={1} value={value} className={`resize-none ${className}`} {...props} />;
});
