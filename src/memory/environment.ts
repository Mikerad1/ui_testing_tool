export const LEGACY_MEMORY_ENVIRONMENT = 'legacy';

const MEMORY_ENVIRONMENT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function assertMemoryEnvironment(value: unknown, allowLegacy = true): string {
  if (typeof value !== 'string' || !MEMORY_ENVIRONMENT_PATTERN.test(value)
    || (!allowLegacy && value === LEGACY_MEMORY_ENVIRONMENT)) {
    throw new Error('Invalid memory environment');
  }
  return value;
}

export function isConfiguredMemoryEnvironment(value: unknown): value is string {
  try {
    assertMemoryEnvironment(value, false);
    return true;
  } catch {
    return false;
  }
}
