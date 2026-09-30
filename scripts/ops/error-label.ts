/** Safe instructions built from arguments/configuration, never database row values or raw errors. */
export class OperatorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorRefusal';
  }
}

/** Preserve explicit safe refusals; other failures reveal only a Prisma code or error class. */
export function operatorErrorLabel(error: unknown): string {
  try {
    if (error instanceof OperatorRefusal) return error.message;
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
