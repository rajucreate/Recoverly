import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError('Route not found', { statusCode: 404, code: 'ROUTE_NOT_FOUND', details: { path: req.originalUrl } }));
}

export function errorHandler(error, _req, res, _next) {
  if (error instanceof AppError) return respond(res, error.statusCode, error.code, error.message, error.details);
  if (error instanceof Prisma.PrismaClientKnownRequestError) return respond(res, 500, 'PERSISTENCE_ERROR', 'A database operation failed');
  if (error instanceof Prisma.PrismaClientValidationError) return respond(res, 500, 'PERSISTENCE_ERROR', 'A database operation failed');
  return respond(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred');
}

function respond(res, status, code, message, details) {
  const error = { code, message };
  if (details) error.details = details;
  return res.status(status).json({ error });
}
