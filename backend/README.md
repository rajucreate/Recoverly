# Payment Failure Recovery Backend

Node.js/Express API using PostgreSQL and Prisma. Phase 1 implements transaction creation and retrieval plus the persistence schema for payment attempts and recovery actions.

## Setup

1. Use Node.js `24.4.1` (the installed LTS-compatible environment version).
2. Run `npm install` from `backend/`.
3. Copy `.env.example` to `.env`, then set `DATABASE_URL` for your PostgreSQL database.
4. Create the named PostgreSQL database, for example: `createdb payment_recovery`.
5. Run `npm run prisma:deploy` to apply migrations.
6. Run `npm start` (or `npm run dev`).

## Commands

- `npm test` — run Jest and Supertest API tests.
- `npm run lint` — syntax checks for application entry points.
- `npm run prisma:generate` — regenerate Prisma Client.
- `npm run prisma:migrate -- --name <name>` — create and apply a development migration.

## Implemented endpoints

`POST /api/transactions`

```json
{ "amount": 5000, "currency": "INR", "customerId": "customer-001" }
```

Returns `201` with a `PENDING` transaction. Amounts are returned as strings to preserve exact decimal precision.

`GET /api/transactions/{transactionId}` returns the transaction, `paymentAttempts`, and `recoveryActions`. An unknown ID returns a JSON `404` error; malformed IDs return `400`.

`POST /api/transactions/{transactionId}/attempts` records an outcome for a non-successful transaction. The server assigns `attemptNumber`; clients must not send it. A successful outcome is terminal for now and makes the transaction `SUCCESS`; a failed outcome makes it `FAILED` and may be followed by another attempt.

```json
{
  "paymentMethod": "UPI",
  "outcome": "FAILED",
  "failureCategory": "TEMPORARY_FAILURE",
  "failureReason": "Bank server temporarily unavailable"
}
```

```json
{
  "data": {
    "id": "uuid",
    "amount": "5000",
    "currency": "INR",
    "customerId": "customer-001",
    "status": "PENDING",
    "paymentAttempts": [],
    "recoveryActions": []
  }
}
```
