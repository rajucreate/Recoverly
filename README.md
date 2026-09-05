# Recoverly

Recoverly is a prototype payment-failure recovery system for the Razorpay AI Buildathon's **AI Revenue Recovery** track. It turns a failed payment into a bounded recovery decision, executes an eligible retry or alternate-method attempt, and measures the resulting transaction and monetary outcome. The system combines a frozen offline interaction-logistic model with deterministic safety rules and a rule fallback, backed by PostgreSQL/Prisma persistence, a durable recovery-job worker, decision audit records, feedback records, and a React dashboard. The implementation is designed to demonstrate the closed loop **Detect -> Decide -> Execute -> Measure**; it is not a production payment integration or a claim of production ML performance.

## Problem statement

Payment failures represent revenue at risk, but retrying indiscriminately can create duplicate attempts, poor customer experiences, and operational ambiguity. Recoverly treats recovery as a constrained decision problem: choose the best safe action available for the observed failure context, stop when the policy says to stop, and count revenue only when a later payment attempt actually succeeds.

## How Recoverly works

1. **Detect:** A transaction and payment attempt are persisted. Failed attempts include a failure category and reason.
2. **Decide:** The decision policy scores `RETRY`, `ALTERNATE_METHOD`, `CUSTOMER_ACTION`, and `ESCALATE`. It filters unsafe candidates first, then selects the highest-probability safe candidate. If the model is unavailable, invalid, or has no safe candidate, the deterministic rule engine is used.
3. **Execute:** Payment recovery can run synchronously or through a PostgreSQL-backed recovery job. Provider results become subsequent payment attempts and update the recovery action and transaction state.
4. **Measure:** Analytics distinguish action outcomes, transaction resolution, monetary recovery, batch scope, model runtime observations, audit records, and feedback.

The objective is safely recovered revenue, not maximizing the number of retries.

## Core recovery workflow

The main transaction flow is:

```text
Create transaction (PENDING)
	-> record initial payment attempt
	-> failure changes transaction to FAILED
	-> policy creates a recovery action and explanation
	-> execute directly or enqueue a recovery job
	-> provider result creates a subsequent attempt
	-> SUCCESS or bounded failure/stoppage is measured
```

Supported decision actions are `RETRY`, `ALTERNATE_METHOD`, `CUSTOMER_ACTION`, and `ESCALATE`. Only `RETRY` and `ALTERNATE_METHOD` invoke a payment provider. Customer-action and escalation actions are recorded as executed decisions without a payment attempt.

## ML/AI component

### Model and features

The runtime loads the persisted `phase2-interaction-logistic-v1` artifact from `data/phase-2/models/recovery_interaction_v1.model.json`. It is an interaction logistic-regression model implemented in the repository; there is no external ML runtime dependency.

Decision-time features include:

- transaction amount and currency
- attempted payment method
- failure category and whether a failure reason is present
- current attempt number
- prior failed-attempt count
- prior temporary-failure count
- candidate action type

Numeric fields are passed through with fixed scaling from the training split, boolean values are encoded as `0`/`1`, and categorical values use fixed one-hot vocabularies. The feature pipeline rejects post-decision and outcome fields such as `recovery_success`, selected action, transaction IDs, and future history.

### Prediction and decision process

The prediction service generates one probability for each candidate action. The policy validates model output and version compatibility, removes candidates that violate safety constraints, and ranks the remaining candidates by predicted recovery probability. It falls back to the rule engine for `MODEL_UNAVAILABLE`, `INVALID_PREDICTION`, or `NO_SAFE_CANDIDATE`.

### Offline evaluation

The committed artifacts report offline results on synthetic data, not production performance:

- Dataset: `v1`, 6,000 generated rows; the held-out test split contains 1,200 chronological rows.
- Model: `phase2-interaction-logistic-v1`, evaluated without retraining or tuning.
- Held-out test: ROC-AUC `0.8364`, PR-AUC `0.7971`, log loss `0.5095`, Brier score `0.1670`, accuracy `0.7608`, precision `0.7359`, recall `0.7399`, F1 `0.7379`.
- Offline rule-vs-ML replay on the same 1,200 scenarios: rule expected recovery rate `54.33%`; ML policy expected recovery rate `54.73%`, an absolute difference of `0.40` percentage points.

The rule-vs-ML result is a synthetic counterfactual evaluation using the repository's ground-truth outcome function. It is not an online A/B test, causal uplift measurement, or production business result. The evaluation also shows a lower ML rate for the `CUSTOMER_ACTION_REQUIRED` segment, so the aggregate lift should not be read as uniformly better behavior.

## Recovery actions

- **Retry:** Reuses the failed attempt's payment method. The rule engine permits this only for temporary failures below its retry limit.
- **Alternate method:** Requires a different valid method from `UPI`, `CARD`, or `NET_BANKING`.
- **Customer action:** Records that customer intervention is required; it does not call a provider.
- **Escalate:** Records that the failure should be escalated; it does not call a provider.

## Safety and bounded recovery

- **Retry limits:** The deterministic decision engine uses `RETRY_LIMIT = 2` prior temporary failures. Queued jobs default to `maxAttempts = 3`, configurable with `RECOVERY_MAX_ATTEMPTS`.
- **Backoff:** Retryable queued provider failures use exponential delay, default base `1,000 ms`, maximum `60,000 ms`, and jitter ratio `0.2`. These values are configurable.
- **Idempotency:** Recovery actions are unique per triggering attempt. Recovery jobs use a unique action-based idempotency key, and provider requests use `recovery:<recoveryActionId>`.
- **Job states:** `QUEUED -> PROCESSING -> SUCCEEDED`, `FAILED`, `RETRY_PENDING`, or `DEAD_LETTER`; due retries return to `QUEUED`.
- **Stale leases:** Processing jobs receive a lease. The lease reaper finds expired leases, returns jobs to retry-pending when attempts remain, or dead-letters them when the limit is reached.
- **Fencing:** Job claims increment `claimVersion`. Completion and failure updates require the current claim version, preventing an old worker claim from completing a newer claim.
- **Dead letters:** Exhausted retry attempts and exhausted stale leases transition to `DEAD_LETTER` and retain failure details.

These controls bound automated execution; they do not make the prototype safe for unreviewed production payment traffic.

## Payment provider abstraction

Provider calls go through the `PaymentProvider` adapter contract and are selected with `PROVIDER`:

- `simulator` is the default and accepts explicit `SUCCESS` or `FAILED` test directives.
- `razorpay` exists as an abstraction boundary, but its implementation deliberately throws `LIVE_EXECUTION_DISABLED`. This repository does not contain a live Razorpay payment execution integration.

## Auditability, explanations, and feedback

Decision records persist the selected action, source (`ML` or `RULE`), probability when applicable, context, candidate predictions, rejected candidates, fallback details, version fields, and decision latency. The explanation layer is downstream of decisioning and produces structured and human-readable explanations, including safety rejection reasons such as retry-limit exceeded, unsafe alternate method, already executed action, or non-failed transaction.

After execution, feedback records correlate the transaction, trigger attempt, action, execution attempt, audit ID, model version, decision context, and execution outcome. Feedback recording is observational: a feedback persistence failure does not undo an already completed recovery execution.

## Monetary recovery definition

Recoverly counts monetary recovery only when the transaction has a **successful subsequent payment attempt**: an attempt with `status = SUCCESS` and `attemptNumber > 1`. The recovered amount is the original transaction amount for those transactions. A recommendation, an executed customer-action/escalation, a successful action record without a subsequent payment success, or a model probability does not by itself count as recovered revenue.

## Batch-level revenue analytics

`RecoveryAnalyticsService` can aggregate all transactions or a supplied UUID list. It reports revenue at risk, revenue recovered, monetary recovery rate, recovered/failed/stopped/pending counts, action-level performance, transaction resolution, retry and alternate-method rates, escalation, failure-category breakdowns, runtime ML decision statistics, and the stored rule-vs-ML benchmark. Mixed currencies are rejected for a single monetary summary.

The frontend dashboard consumes this endpoint and supports pasting a comma-separated transaction UUID list to evaluate a batch scope.

## Showcase/demo batch

The showcase generator creates a deterministic **synthetic** batch named `recoverly-showcase-v1`:

- 500 INR transactions using seed `20260905`.
- Verified showcase outcome: 290 `RECOVERED`, 75 `FAILED`, 75 `STOPPED`, and 60 `PENDING` transactions.
- Uses a local showcase provider with explicit outcomes and intentionally uses the normal rule fallback rather than model output to fabricate outcomes.
- Writes a manifest to `data/demo/recoverly-showcase-v1.json` containing the batch ID, seed, and generated transaction IDs.

The committed manifest provides identifiers, not committed analytics totals. Run the report and verification commands against a configured database to calculate and verify actual batch metrics.

## Architecture

```text
React/Vite dashboard
				|
				v
Express routes/controllers
				|
				+--> TransactionService --> decision policy --> prediction service
				|                                  |             |
				|                                  |             +--> frozen model artifact
				|                                  +--> rule fallback
				|
				+--> RecoveryExecutionService --> provider abstraction
				|
				+--> RecoveryJobService --> PostgreSQL job queue --> RecoveryWorker
				|                                      ^                 |
				|                                      |                 +--> lease reaper
				v                                      v
PostgreSQL via Prisma: transactions, attempts, actions, jobs,
audit records, feedback records, and analytics source data
```

The Node server starts the recovery worker and lease reaper with the HTTP application. The queue uses PostgreSQL row locking with `SKIP LOCKED` for job claims.

## Technology stack

- Backend: Node.js ES modules, Express 5, Prisma 6, PostgreSQL, CORS, dotenv.
- Frontend: React 19, React DOM, Vite 7.
- Testing: Jest 30 and Supertest 7.
- ML and evaluation: repository-local JavaScript implementations, JSON model artifacts, CSV datasets, and Markdown evaluation reports.

## API overview

All routes are prefixed as shown below. JSON responses use a top-level `data` property for successful responses.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/transactions` | Create a transaction. |
| `GET` | `/api/transactions/:transactionId` | Retrieve a transaction, attempts, and recovery actions. |
| `POST` | `/api/transactions/:transactionId/attempts` | Record an initial or subsequent payment attempt. |
| `POST` | `/api/transactions/:transactionId/recovery/execute` | Execute a recommended recovery action directly. |
| `POST` | `/api/transactions/:transactionId/recovery/jobs` | Queue a provider recovery action; returns `202`. |
| `GET` | `/api/recovery-jobs/:jobId` | Retrieve a recovery job. |
| `GET` | `/api/analytics/recovery` | Retrieve full or UUID-filtered recovery analytics. |

`POST /api/transactions` accepts `amount`, `currency`, and `customerId`. Failed attempts require `paymentMethod`, `outcome: "FAILED"`, `failureCategory`, and `failureReason`. Recovery execution requires `recoveryActionId`; alternate-method actions also require a different `paymentMethod`. The simulator accepts `providerOutcome: "SUCCESS"` or `"FAILED"`.

## Local setup and run

Prerequisites: Node.js, PostgreSQL, and a database reachable through `DATABASE_URL`.

```powershell
cd backend
npm install
Copy-Item .env.example .env
# Edit .env and set DATABASE_URL for your PostgreSQL database.
npm run prisma:deploy
npm start
```

The backend defaults to 'http://localhost:3000' and the simulator provider. Useful backend scripts are:

```powershell
npm run dev       # watch-mode server
npm test          # Jest/Supertest suite
npm run lint      # Node syntax checks for app.js and server.js
```

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

The frontend client defaults to 'http://localhost:3000/api'. Set `VITE_API_BASE_URL` in the frontend environment if the backend is elsewhere. The frontend also supports `npm run build` and `npm run lint`.

## Showcase batch commands

Run these from `backend/` with the database configured:

```powershell
npm run demo:showcase          # create the deterministic synthetic batch
npm run demo:showcase:report   # calculate analytics for its manifest IDs
npm run demo:showcase:verify   # verify IDs, isolation, and monetary definitions
npm run demo:showcase:reset    # remove and recreate only this showcase batch
npm run demo:showcase:cleanup  # remove this batch and its manifest
```

The generator refuses to overwrite an existing showcase batch unless `--reset` is used.

## Testing

The repository includes Jest/Supertest tests covering API hardening, transaction flows, decision policy and explanations, prediction and evaluation artifacts, feedback and analytics, durable persistence, recovery jobs, reliability, and performance/security cases. The configured command is `npm test` from `backend/`. This README does not claim a passing test-run result because no test run is stored as part of this documentation update.

## Project structure

```text
backend/
	prisma/                 Prisma schema and migrations
	src/routes/             Express route definitions
	src/controllers/        HTTP controllers
	src/services/           Transactions, execution, retry, and job state
	src/intelligence/       Features, models, policy, audit, feedback, analytics
	src/providers/          Simulator and disabled live-provider boundary
	src/queue/ workers/     Durable queue, worker, and stale-lease reaper
	scripts/                Showcase batch generator
	tests/                  Jest/Supertest test suite
data/
	demo/                   Showcase manifest
	phase-2/                Synthetic datasets, splits, schemas, and model artifacts
docs/phase-2/             ML, policy, explainability, and evaluation reports
frontend/src/             React dashboard, transaction views, and API client
```

## Limitations

- Payment execution is simulated by default; the Razorpay provider is intentionally disabled.
- ML data and offline comparisons are synthetic and do not establish production accuracy, causal uplift, or live provider behavior.
- The showcase manifest is not a self-contained analytics report; its metrics must be generated from the database.
- There is no authentication, authorization, rate limiting, or deployment configuration in the reviewed application surface.
- The worker and lease reaper run in the same Node process as the HTTP server.
- The frontend is a buildathon dashboard and workflow client, not evidence of a hosted production control plane.

## Current project status

Recoverly is a buildathon prototype with an implemented end-to-end recovery loop, durable persistence model, bounded job execution, explainable ML/rule decisioning, synthetic offline evaluation artifacts, and a usable local dashboard. It should be evaluated as a technically demonstrable prototype. Live payment-provider integration, production operations, real customer data, and production ML validation remain outside the repository's current capabilities.

## Inspected evidence

This README was based on the repository's `backend/package.json`, `frontend/package.json`, Prisma schema, Express route definitions and controllers, transaction/recovery/job/intelligence/provider implementations, React dashboard and API client, ML artifacts and reports under `data/phase-2` and `docs/phase-2`, `backend/scripts/showcase-recovery-batch.js`, and `data/demo/recoverly-showcase-v1.json`.

Deliberately excluded claims include live Razorpay execution, production readiness, real-world recovery lift, hosted deployment, committed showcase revenue totals, and a passing test result from this update. Those claims were not verifiable from the implemented repository state.
