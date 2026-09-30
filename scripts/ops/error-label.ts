/** Operator failures reveal only a Prisma code or an error class, never row/connection details. */
export function operatorErrorLabel(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const value = error as { code?: unknown; errorCode?: unknown };
      for (const key of ['code', 'errorCode'] as const) {
        const code = value[key];
        if (typeof code === 'string' && /^P\d{4}$/.test(code)) return code;
      }
    }
    if (error instanceof Error) {
      // Error.name is mutable and can contain arbitrary runtime data.
      const name = error.constructor.name;
      return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'Error';
    }
  } catch {
    // A malformed thrown object must not make the failure reporter throw too.
  }
  return 'UnknownError';
}
