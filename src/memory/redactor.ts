const REDACTION_ERROR = 'Memory input could not be safely redacted';
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

export type MemoryRedactionConfig = {
  sensitive_paths: readonly string[];
  sensitive_values_env: readonly string[];
};

export type MemoryRedactor = {
  redactText(text: string): string;
  redactValue(value: unknown): unknown;
  redactWorkflowVariables(workflow: unknown, resolved: Record<string, string>): Record<string, string>;
};

const textPatterns: readonly [RegExp, string][] = [
  [/['"]?\b(?:token|session|sid|credential|private[_-]?key)\b['"]?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, REDACTED],
  [/(["']?\bauthorization\b["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]'],
  [/(["']?\b(?:password|passwd|pwd|secret|secret[_-]?key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?id|csrf[_-]?token)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]'],
  [/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]*/gi, 'Cookie: [REDACTED]'],
  [/([?&#](?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?id|code|auth)=)[^&#\s"'<>]*/gi, '$1[REDACTED]'],
  [/\b(https?:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/gi, '$1[REDACTED]@'],
  [/\beyJ[a-zA-Z0-9_-]{5,}\.eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\b/g, REDACTED],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, REDACTED],
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw new Error(REDACTION_ERROR);
  return pointer.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pointerFor(segments: readonly (string | number)[]): string {
  return segments.length === 0 ? '' : `/${segments.map(segment => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

export function createMemoryRedactor(
  config: MemoryRedactionConfig,
  env: NodeJS.ProcessEnv = process.env,
): MemoryRedactor {
  let configuredValues: string[];
  let sensitivePointers: Set<string>;
  try {
    configuredValues = config.sensitive_values_env.map(name => {
      const value = env[name];
      if (typeof value !== 'string' || value.length === 0) throw new Error(REDACTION_ERROR);
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) throw new Error(REDACTION_ERROR);
      return value;
    });
    sensitivePointers = new Set(config.sensitive_paths.map(pointer => {
      pointerSegments(pointer);
      return pointer;
    }));
  } catch {
    throw new Error(REDACTION_ERROR);
  }

  configuredValues = [...new Set(configuredValues)].sort((left, right) => right.length - left.length);

  const redactText = (text: string): string => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STRING_BYTES) throw new Error(REDACTION_ERROR);
    let result = text;
    for (const [pattern, replacement] of textPatterns) result = result.replace(pattern, replacement);
    for (const value of configuredValues) result = result.split(value).join(REDACTED);
    return result;
  };

  const redactValue = (value: unknown): unknown => {
    let nodes = 0;
    let totalBytes = 0;
    const seen = new WeakSet<object>();

    const visit = (current: unknown, segments: (string | number)[], depth: number): unknown => {
      nodes += 1;
      if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error(REDACTION_ERROR);
      if (sensitivePointers.has(pointerFor(segments))) return REDACTED;
      if (typeof current === 'string') {
        const bytes = Buffer.byteLength(current, 'utf8');
        totalBytes += bytes;
        if (bytes > MAX_STRING_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error(REDACTION_ERROR);
        return redactText(current);
      }
      if (current === null || typeof current === 'boolean') return current;
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) throw new Error(REDACTION_ERROR);
        return current;
      }
      if (Array.isArray(current)) {
        if (seen.has(current)) throw new Error(REDACTION_ERROR);
        seen.add(current);
        return current.map((entry, index) => visit(entry, [...segments, index], depth + 1));
      }
      if (isPlainRecord(current)) {
        if (seen.has(current)) throw new Error(REDACTION_ERROR);
        seen.add(current);
        const entries = Object.entries(current);
        if (entries.some(([key]) => Buffer.byteLength(key, 'utf8') > MAX_STRING_BYTES)) throw new Error(REDACTION_ERROR);
        totalBytes += entries.reduce((sum, [key]) => sum + Buffer.byteLength(key, 'utf8'), 0);
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(REDACTION_ERROR);
        return Object.fromEntries(entries.map(([key, entry]) => [key, visit(entry, [...segments, key], depth + 1)]));
      }
      throw new Error(REDACTION_ERROR);
    };

    try {
      return visit(value, [], 0);
    } catch {
      throw new Error(REDACTION_ERROR);
    }
  };

  const redactWorkflowVariables = (workflow: unknown, resolved: Record<string, string>): Record<string, string> => {
    const declarations = isPlainRecord(workflow) && isPlainRecord(workflow.variables) ? workflow.variables : {};
    try {
      return Object.fromEntries(Object.entries(resolved).map(([name, value]) => {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) throw new Error(REDACTION_ERROR);
        const declaration = declarations[name];
        if (isPlainRecord(declaration) && declaration.sensitive === true) return [name, REDACTED];
        return [name, redactText(value)];
      }));
    } catch {
      throw new Error(REDACTION_ERROR);
    }
  };

  return { redactText, redactValue, redactWorkflowVariables };
}
