export class AnalyticsController {
  constructor(analyticsService) {
    this.analyticsService = analyticsService;
  }

  getRecoveryAnalytics = async (req, res) => {
    const data = await this.analyticsService.getAnalyticsSummary();
    res.status(200).json({ data });
  };
}

