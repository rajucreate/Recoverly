import { toRecoveryActionResponse } from '../dto/transaction-dto.js';
import { validateCreatePaymentAttempt, validateCreateTransaction, validateRecoveryExecution } from '../utils/validation.js';

export class TransactionController {
  constructor(transactionService, recoveryExecutionService) { this.transactionService = transactionService; this.recoveryExecutionService = recoveryExecutionService; }

  create = async (req, res) => {
    const transaction = await this.transactionService.createTransaction(validateCreateTransaction(req.body));
    res.status(201).json({ data: transaction });
  };

  getById = async (req, res) => {
    const transaction = await this.transactionService.getTransaction(req.params.transactionId);
    res.status(200).json({ data: transaction });
  };

  createAttempt = async (req, res) => {
    const result = await this.transactionService.createPaymentAttempt(req.params.transactionId, validateCreatePaymentAttempt(req.body));
    res.status(201).json({ data: { attempt: result.attempt, recoveryAction: result.recoveryAction ? toRecoveryActionResponse(result.recoveryAction) : null } });
  };

  executeRecovery = async (req, res) => {
    const result = await this.recoveryExecutionService.execute(req.params.transactionId, validateRecoveryExecution(req.body));
    res.status(200).json({ data: result });
  };
}
