import { validateTransactionIdsQuery } from '../utils/validation.js';

export class AnalyticsController {
  constructor(analyticsService) {
    this.analyticsService = analyticsService;
  }

  getRecoveryAnalytics = async (req, res) => {
    const transactionIds = validateTransactionIdsQuery(req.query.transactionIds);
    const data = await this.analyticsService.getAnalyticsSummary({ transactionIds });
    res.status(200).json({ data });
  };
}
