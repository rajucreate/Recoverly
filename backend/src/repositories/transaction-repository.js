import { transactionRelations } from '../entities/transaction.js';

export class TransactionRepository {
  constructor(prisma) { this.prisma = prisma; }

  create(data) { return this.prisma.transaction.create({ data }); }

  findByIdWithHistory(id) {
    return this.prisma.transaction.findUnique({ where: { id }, include: transactionRelations });
  }

  findByIdForAttempt(id) {
    return this.prisma.transaction.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        _count: { select: { paymentAttempts: true } },
        paymentAttempts: {
          where: { status: 'FAILED', failureCategory: 'TEMPORARY_FAILURE' },
          select: { id: true }
        }
      }
    });
  }

  createPaymentAttempt(data) { return this.prisma.paymentAttempt.create({ data }); }

  updateStatus(id, status) { return this.prisma.transaction.update({ where: { id }, data: { status } }); }

  executeInTransaction(work) {
    return this.prisma.$transaction(
      async (transactionClient) => work(new TransactionRepository(transactionClient)),
      { isolationLevel: 'Serializable' }
    );
  }
}
