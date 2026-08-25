import { validateUuid } from '../utils/validation.js';

export function validateTransactionId(req, _res, next) {
  try {
    validateUuid(req.params.transactionId);
    next();
  } catch (error) {
    next(error);
  }
}
