export class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource, id) {
    super(`${resource} not found`, { statusCode: 404, code: 'RESOURCE_NOT_FOUND', details: { id } });
  }
}

export class BusinessRuleError extends AppError {
  constructor(message, details) {
    super(message, { statusCode: 409, code: 'BUSINESS_RULE_VIOLATION', details });
  }
}
