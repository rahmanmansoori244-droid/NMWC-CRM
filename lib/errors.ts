export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly fields?: Record<string, string>;

  constructor(code: string, message: string, httpStatus = 500, fields?: Record<string, string>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.fields = fields;
  }
}

export class ValidationError extends AppError {
  constructor(fields: Record<string, string>, message = 'Validation failed') {
    super('VALIDATION_FAILED', message, 400, fields);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, 429);
  }
}
