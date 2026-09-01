import { toRecoveryActionResponse } from '../dto/transaction-dto.js';
import { validateCreatePaymentAttempt, validateCreateTransaction, validateRecoveryExecution } from '../utils/validation.js';
import { RecoveryFeedbackService } from '../intelligence/recovery-feedback-service.js';

export class TransactionController {
  constructor(transactionService, recoveryExecutionService, feedbackService = new RecoveryFeedbackService()) {
    this.transactionService = transactionService;
    this.recoveryExecutionService = recoveryExecutionService;
    this.feedbackService = feedbackService;
  }

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
    res.status(201).json({
      data: {
        attempt: result.attempt,
        recoveryAction: result.recoveryAction ? toRecoveryActionResponse(result.recoveryAction) : null,
        explanation: result.explanation ?? null
      }
    });
  };

  executeRecovery = async (req, res) => {
    const result = await this.recoveryExecutionService.execute(req.params.transactionId, validateRecoveryExecution(req.body));

    if (this.feedbackService && result?.recoveryAction) {
      try {
        const action = result.recoveryAction;
        const attempt = result.attempt;
        this.feedbackService.recordFeedback({
          transactionId: req.params.transactionId,
          attemptId: action.attemptId,
          recoveryActionId: action.id,
          executionAttemptId: attempt?.id ?? null,
          recoveryAction: action.actionType,
          decisionReason: action.reason,
          executionOutcome: attempt ? attempt.status : action.status,
          outcomeTimestamp: attempt?.createdAt ?? action.createdAt,
          executionResult: result
        });
      } catch {
        // Purely observational: feedback recording failure must never fail an already-completed recovery execution
      }
    }

    res.status(200).json({ data: result });
  };
}
