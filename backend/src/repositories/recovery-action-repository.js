export class RecoveryActionRepository {
  constructor(prisma) { this.prisma = prisma; }

  create(data) { return this.prisma.recoveryAction.create({ data }); }

  findByIdForTransaction(id, transactionId) {
    return this.prisma.recoveryAction.findFirst({
      where: { id, transactionId },
      include: { attempt: { select: { paymentMethod: true } } }
    });
  }

  async transitionStatus(id, fromStatus, toStatus) {
    const result = await this.prisma.recoveryAction.updateMany({
      where: { id, status: fromStatus },
      data: { status: toStatus }
    });
    return result.count === 1;
  }
}
