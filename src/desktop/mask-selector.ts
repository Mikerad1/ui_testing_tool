/**
 * The mask observer can safely latch every document child/attribute mutation only when
 * selector membership cannot change through pseudo-state or relational matching.
 * Keep this grammar intentionally smaller than general CSS.
 */
export const MASK_SELECTOR_SUBSET_ERROR = 'mask_selectors supports a single DOM-stable compound selector: optional tag name or *, followed only by #id, .class, [attribute], or [attribute=value] clauses. Pseudo-classes/elements, combinators, selector lists, escapes, comments, and other CSS are unsupported.';

export function isStableMaskSelector(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  let index = 0;
  const identifier = (): boolean => {
    const first = value[index];
    if (!first || !/[A-Za-z_]/.test(first) && !(first === '-' && /[A-Za-z_-]/.test(value[index + 1] ?? ''))) return false;
    index++;
    while (index < value.length && /[A-Za-z0-9_-]/.test(value[index]!)) index++;
    return true;
  };

  let hasComponent = false;
  if (value[index] === '*') { index++; hasComponent = true; }
  else if (identifier()) hasComponent = true;

  while (index < value.length) {
    const marker = value[index];
    if (marker === '#' || marker === '.') {
      index++;
      if (!identifier()) return false;
      hasComponent = true;
      continue;
    }
    if (marker !== '[') return false;
    index++;
    if (!identifier()) return false;
    if (value[index] === '=') {
      index++;
      const quote = value[index];
      if (quote === '"' || quote === "'") {
        index++;
        while (index < value.length && value[index] !== quote && value[index] !== '\\' && value.charCodeAt(index) >= 0x20) index++;
        if (value[index] !== quote) return false;
        index++;
      } else if (!identifier()) return false;
    }
    if (value[index] !== ']') return false;
    index++;
    hasComponent = true;
  }
  return hasComponent && index === value.length;
}
