# Hotel Management System — Full-stack Microservices

A hotel booking platform with a **NestJS-hosted React SSR portal**, a **Node.js (Express)
microservices backend**, **PostgreSQL**, **RabbitMQ**, and **Redis**. Each backend service is
independently deployable, owns its own database schema, and communicates with peers over REST
and durable events.

## Architecture

```
                        ┌──────────────────────────┐
   Browser ──► :8080 ──►│ NestJS + React SSR      │
                        └────────────┬─────────────┘
                                     │ /api/*
                        ┌────────────▼─────────────┐
              :3000 ───►│       API Gateway        │  JWT verification, routing
                        └───────┬──────────────────┘
        ┌───────────┬───────────┼───────────────┬──────────────┬───────────────┬──────────────────┐
        ▼           ▼           ▼               ▼              ▼               ▼                  ▼
  auth-service users-service rooms-service bookings-service payment-service operations-service notifications-service
     :3001         :3002        :3003            :3004           :3006          :3007              :3005
        │           │           │               │              │                  ▲
        └───────────┴─────┬─────┴───────────────┴──────────────┴──────────────────┘
                   ┌──────┴──────┐
                   ▼             ▼
             PostgreSQL       RabbitMQ
                :5432           :5672
        (schemas: auth, users, rooms, bookings, payments, operations, notifications)

        Redis :6379 — gateway rate limits and room-type catalogue cache
```

| Service | Responsibility | Schema |
|---|---|---|
| **frontend** | NestJS-hosted React SSR guest, staff, and admin portal with API proxy | — |
| **api-gateway** | Single entry point, JWT verification, reverse proxy | — |
| **auth-service** | Register, login, JWT issuing, role management | `auth` |
| **users-service** | Guest/staff profile CRUD | `users` |
| **rooms-service** | Room types, rooms, availability, reservations (inventory) | `rooms` |
| **bookings-service** | Guest-only booking requests, administrator approval, cancellation, pricing | `bookings` |
| **payment-service** | Guest payments, administrator ledger, idempotent confirmation, refunds and events | `payments` |
| **operations-service** | Dashboard, check-in/out, folios, invoices, housekeeping, reports, audit and settings | `operations` |
| **notifications-service** | Stores and serves notifications (email/SMS hook point) | `notifications` |

## Quick start

Prerequisites: Docker + Docker Compose. Runtime values and secrets are intentionally absent from
`docker-compose.yml`. Create the ignored local environment file first:

```bash
cp .env.example .env
# Replace every CHANGE_ME value in .env. URL-encode passwords used inside connection URLs.
```

Compose refuses to start when a required variable is missing. The root `.dockerignore` also keeps
`.env`, dependency folders, build output, logs, and temporary files out of image build contexts.

```bash
docker compose up --build
```

The stack starts PostgreSQL, RabbitMQ, Redis, the seven domain services, the API gateway, and
the frontend container.

- Portal: [http://127.0.0.1:8080](http://127.0.0.1:8080)
- Direct API access: `http://127.0.0.1:3000`

Backend service ports remain private to the Compose network. The frontend proxies `/api/*` to
the gateway, so the browser only needs the portal origin.

Seeded data: 3 room types (Standard / Deluxe / Suite) and 11 rooms. An admin account is
created automatically on first boot: `admin@hotel.com` / `admin123` (override with `ADMIN_PASSWORD`).

For anything beyond local experimentation, use independently generated values for `JWT_SECRET`,
`INTERNAL_KEY`, the database password, RabbitMQ password, and administrator password. Keep
`PASSWORD_RESET_EXPOSE_TOKEN=false`.

### Upgrading an existing database

PostgreSQL runs `db/init.sql` for a new volume. For an existing volume, the operations service
applies the idempotent Phase 1 schema upgrade during startup, so no Kubernetes migration Job is
required. The older migrations can still be applied manually in controlled environments:

```bash
docker compose exec -T postgres psql -U hotel -d hotel \
  -f /dev/stdin < db/migrations/001_reservation_overlap.sql
docker compose exec -T postgres psql -U hotel -d hotel \
  -f /dev/stdin < db/migrations/002_messaging_and_auth_tokens.sql
docker compose exec -T postgres psql -U hotel -d hotel \
  -f /dev/stdin < db/migrations/003_booking_approval.sql
docker compose exec -T postgres psql -U hotel -d hotel \
  -f /dev/stdin < db/migrations/004_payments.sql
docker compose exec -T postgres psql -U hotel -d hotel \
  -f /dev/stdin < db/migrations/005_phase1_operations.sql
```

The payment service also idempotently initializes its additions. For production, serialize startup
of the operations service or run an equivalent controlled deployment hook so only one replica
attempts schema changes at a time.

### Smoke test

With the stack running, execute the end-to-end check from a temporary Node container:

```bash
docker run --rm --env-file .env --network hotel-management_default \
  -v "$PWD/scripts/smoke-test.js:/smoke-test.js:ro" \
  node:20-alpine node /smoke-test.js http://api-gateway:3000
```

The test covers public catalogue access, registration, login, the admin profile, concurrent
room allocation, cross-user cancellation protection, owner cancellation, refresh-token
rotation and replay detection, admin-only booking confirmation, password reset, and
RabbitMQ-delivered notifications. It also covers payment ownership, idempotent payment intents,
decline-and-retry behavior, successful payment, automatic cancellation refunds, check-in, folios,
manual charges and payments, balance-protected checkout, invoice data, housekeeping turnaround,
dashboard metrics, reports, settings, and audit history. To test
the same API path used by the browser, replace the last argument with `http://frontend:8080`.
It also verifies that administrators and staff cannot create bookings, staff cannot access the
financial ledger, and administrators can identify the guest associated with each charge.

## Frontend portal

The responsive portal provides:

- Public room catalogue with a required room-detail review before the availability-aware booking form.
- Registration, login, automatic refresh-token rotation, logout, and password reset.
- Guest booking requests, approval status, history and cancellation, notifications, and profile editing.
- Guest payment after hotel approval, with visible payment and refund status.
- Administrator confirmation or rejection of pending guest booking requests.
- Finance dashboard for administrators, managers, and accountants showing guest identity, booking, amount, provider,
  status, and payment time.
- Front-desk check-in, open folios, manual stay charges/payments, zero-balance checkout, and printable invoices.
- Housekeeping assignment and dirty → cleaning → clean → inspected → available room turnaround.
- Operational dashboards, date-filtered reports, hotel settings, and an audit trail.
- Rich guest profiles and room operational status controls.
- Role-based portals for Admin, Manager, Receptionist, Housekeeper, and Accountant.

Booking creation is a guest-only capability. Staff and administrator portals do not show room
discovery or booking controls, and the bookings service independently enforces the same rule.

The production image builds separate Vite browser and server bundles. A NestJS rendering server
preloads the public room catalogue, returns complete HTML, hydrates it into the interactive React
portal, and reverse-proxies `/api/*` to the private gateway container. NestJS also exposes the
frontend health endpoint and applies response security policy. Static assets use long-lived cache
headers while rendered pages remain uncached so room inventory stays current.

## Payment flow

The hotel must confirm a pending booking before the guest can pay. The portal then creates an
idempotent payment intent and confirms it with a provider token. The service never accepts or stores
raw card numbers. Successful, failed, and refunded payments publish durable RabbitMQ events; a paid
booking is automatically refunded when its cancellation event arrives.

`PAYMENT_PROVIDER=mock` is an integration-safe simulator for local development and automated tests,
not a production payment processor. Replace the provider adapter with Stripe, Adyen, or another PCI
compliant hosted/tokenized checkout before accepting real payments. Do not send card data through
this application or store it in PostgreSQL.

## Try it

```bash
BASE=http://localhost:3000

# 1. Register a guest
TOKEN=$(curl -s -X POST $BASE/api/auth/register -H 'content-type: application/json' -d '{
  "email": "jane@example.com", "password": "secret1",
  "firstName": "Jane", "lastName": "Doe"
}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 2. Browse room types
curl -s $BASE/api/rooms/room-types

# 3. Submit a pending booking request (use a room type id from step 2)
curl -s -X POST $BASE/api/bookings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "roomTypeId": "<ROOM_TYPE_UUID>", "checkIn": "2026-10-01", "checkOut": "2026-10-04"
}'

# 4. An administrator confirms the pending request
ADMIN_TOKEN=$(curl -s -X POST $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@hotel.com","password":"admin123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -X POST $BASE/api/bookings/<BOOKING_ID>/confirm \
  -H "authorization: Bearer $ADMIN_TOKEN"

# 5. List my bookings, then cancel one
curl -s "$BASE/api/bookings" -H "authorization: Bearer $TOKEN"
curl -s -X POST $BASE/api/bookings/<BOOKING_ID>/cancel -H "authorization: Bearer $TOKEN"

# 6. My notifications
curl -s $BASE/api/notifications/me -H "authorization: Bearer $TOKEN"

# 7. Administrators can promote a guest to staff with PATCH /api/users/:id/role
```

## API overview

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/auth/register` | public | Create guest account, returns JWT |
| `POST /api/auth/login` | public | Login, returns JWT |
| `POST /api/auth/refresh` | public | Rotate refresh token and issue a new access token |
| `POST /api/auth/logout` | public | Revoke a refresh token |
| `POST /api/auth/password-reset/request` | public | Request an expiring reset token |
| `POST /api/auth/password-reset/confirm` | public | Set a new password and revoke sessions |
| `POST /api/auth/change-password` | any | Change password and revoke other sessions |
| `GET /api/users/me` | any | Own profile |
| `GET /api/users` | staff/admin | List profiles |
| `PATCH /api/users/:id/role` | admin | Promote/demote roles |
| `GET /api/rooms/room-types` | public | List room types & prices |
| `POST /api/rooms/room-types` | admin | Create room type |
| `GET /api/rooms` | public | List rooms |
| `POST /api/rooms` | admin | Add room |
| `PATCH /api/rooms/:id` | staff/admin | Set status (maintenance, etc.) |
| `GET /api/rooms/available` | token | Find free room for dates |
| `POST /api/bookings` | guest+ | Submit a pending booking request and hold inventory |
| `GET /api/bookings` | guest (own) / staff (all) | List bookings |
| `POST /api/bookings/:id/confirm` | admin | Confirm a pending booking request |
| `POST /api/bookings/:id/cancel` | owner/staff/admin | Withdraw/reject/cancel and free the room |
| `POST /api/bookings/:id/no-show` | admin/manager/receptionist | Mark a confirmed arrival as no-show |
| `POST /api/payments/manual` | finance/front desk | Record cash/card/bank payment against a folio |
| `GET /api/operations/dashboard` | hotel roles | Live occupancy and daily operations metrics |
| `POST /api/operations/bookings/:id/check-in` | front desk | Check in and open a folio |
| `POST /api/operations/bookings/:id/check-out` | front desk | Close a paid folio and dirty the room |
| `GET /api/operations/folios/:id/invoice` | finance/front desk | Return final invoice data |
| `GET /api/operations/housekeeping` | operations roles | List room-turnaround work |
| `PATCH /api/operations/housekeeping/:id` | admin/manager/housekeeper | Assign or update room cleaning |
| `GET /api/operations/reports/summary` | admin/manager/accountant | Date-filtered Phase 1 report |
| `GET/PATCH /api/operations/settings` | hotel/admin | Read or update hotel defaults |
| `GET /api/operations/audit-logs` | admin/manager | Review important system changes |
| `GET /api/notifications/me` | any | Own notifications |

Roles: `guest`, `admin`, `manager`, `receptionist`, `housekeeper`, `accountant`, plus legacy `staff`.

## Design notes

- **Inter-service communication**: synchronous REST for request/response operations and RabbitMQ
  topic events for domain reactions. Internal REST endpoints use a shared `INTERNAL_KEY` header.
- **Transactional outbox**: booking and authentication events are written in the same PostgreSQL
  transaction as their business state. Confirm publishers relay them to durable RabbitMQ queues;
  consumers use event IDs for idempotency. Failed deliveries retry five times with a delay before
  moving to a per-consumer dead-letter queue.
- **Redis**: the gateway applies fixed-window request limits and the rooms service caches the
  room-type catalogue with mutation-based invalidation.
- **Sessions**: access JWTs expire after 15 minutes by default. Opaque refresh tokens are hashed
  in PostgreSQL, rotated on every use, and all sessions are revoked if reuse is detected.
- **Password reset**: one-time, hashed reset tokens expire after 30 minutes. A successful reset
  revokes all refresh tokens. `PASSWORD_RESET_EXPOSE_TOKEN=true` is for local testing only.
- **Booking approval saga**: a guest request asks `rooms-service` to atomically allocate and hold
  a room, then stores the booking as `pending`. Only an administrator can move it to `confirmed`;
  guests and staff cannot call the confirmation endpoint. Allocation is serialized per room type
  and backed by a PostgreSQL exclusion constraint. Rejection, withdrawal, or cancellation deletes
  the hold, freeing the room instantly.
- **Availability model**: a room is bookable when `status = 'active'` and no overlapping
  active reservation exists (`check_in < new_out AND check_out > new_in`).
- **Database-per-service**: one Postgres instance, one schema per service, separate
  `search_path` per connection. Split into per-service databases when scaling out.
- **Shared code**: `packages/shared` is consumed by each service via an npm `file:` link
  (pool factory, JWT middleware, role guard, inter-service HTTP client, error handling).

## Health checks and logs

Every application container exposes `GET /health`. The response includes `status`, `service`,
`version`, `uptimeSeconds`, and `timestamp`; the payment service also reports its configured
provider. Docker health checks use these endpoints to control dependency startup. PostgreSQL,
Redis, and RabbitMQ use their native health commands.

Application services write newline-delimited JSON to stdout/stderr. Access logs include:

- `service`, `level`, `logType`, timestamp and message
- `requestId` (accepted or generated as `x-request-id` and propagated by the gateway)
- HTTP method, path without query parameters, status code and duration
- authenticated user ID and role when available
- stack traces for unexpected server errors

Secrets, authorization headers, passwords, tokens, cookies and card-related fields are redacted.
Successful `/health` requests are excluded by default to avoid log noise. Docker rotates local log
files using `LOG_MAX_SIZE` and `LOG_MAX_FILES`.

Recommended production export categories are:

1. **Access logs** — request rate, latency, status codes, routes and correlation IDs.
2. **Application/error logs** — exceptions, startup, dependency failures and validation failures.
3. **Security logs** — login failures, password changes, role/account changes and authorization denials.
4. **Business audit logs** — reservation confirmation, check-in/out, folio, payment, refund and housekeeping actions. These remain in `operations.audit_logs` and should also be archived.
5. **Infrastructure logs** — PostgreSQL, Redis, RabbitMQ, container restarts and Kubernetes events.

The Compose stack includes **Grafana Loki + Grafana Alloy + Grafana**. Alloy discovers Docker
containers through the read-only Docker socket, parses application JSON, attaches service,
environment, severity and log-type labels, and forwards logs to Loki. Grafana automatically
provisions Loki plus the **Hotel Management Logs** dashboard.

- Grafana: [http://127.0.0.1:3200](http://127.0.0.1:3200)
- Username: `GRAFANA_ADMIN_USER`
- Password: `GRAFANA_ADMIN_PASSWORD` (or the local `ADMIN_PASSWORD` fallback)
- Loki retention: `LOKI_RETENTION_PERIOD` (`168h` by default)

Keep audit and financial logs longer than access logs according to local legal and accounting
requirements. Do not export request bodies, access/refresh tokens, reset tokens, passwords, raw
card data, cookies, or full passport/identity values. The Docker socket grants powerful host access;
the Alloy mount is read-only, and the collector should run only on trusted infrastructure.

Useful local commands:

```bash
docker compose logs -f --tail=200
docker compose logs -f api-gateway operations-service payment-service
```

Useful LogQL examples in Grafana Explore:

```logql
{application="hotel-management", service="api-gateway"}
{application="hotel-management", level="error"}
{application="hotel-management"} | json | requestId="YOUR_REQUEST_ID"
{application="hotel-management", log_type="access"} | json | durationMs > 1000
```

Logging controls are documented in `.env.example`: `LOG_LEVEL`, `SLOW_REQUEST_MS`,
`LOG_HEALTH_REQUESTS`, `LOG_CLIENT_IP`, `SERVICE_VERSION`, `LOG_MAX_SIZE`, and `LOG_MAX_FILES`.

## Container image CI

`.github/workflows/docker-images.yml` builds and pushes all nine application images to Docker Hub
on every Git push. Images are tagged only with the first 12 characters of the Git commit SHA; the
workflow never creates or updates a `latest` or release-version tag. Each tag is a multi-platform
manifest containing `linux/amd64` and `linux/arm64`, so the same image reference works on x86_64
and 64-bit ARM K3s nodes.

Configure the following in the GitHub repository under **Settings > Secrets and variables >
Actions**:

- Repository variable `DOCKERHUB_NAMESPACE`: the public Docker Hub user or organization name.
- Repository secret `DOCKERHUB_USERNAME`: the Docker Hub account used by the workflow.
- Repository secret `DOCKERHUB_TOKEN`: a Docker Hub access token with permission to push images.

Create public Docker Hub repositories named `hotel-management-<service>` for each service, or grant
the workflow account permission to create them. Published image references use this format:

```text
docker.io/<namespace>/hotel-management-api-gateway:<12-character-commit-sha>
docker.io/<namespace>/hotel-management-auth-service:<12-character-commit-sha>
docker.io/<namespace>/hotel-management-frontend:<12-character-commit-sha>
```

## Production hardening (next steps)

- Add schema-based request validation (zod/joi), tracing (OpenTelemetry), and metrics.
- Real email/SMS providers in `notifications-service` (SES, Twilio) and email verification.
- Add outbox retention and automated token cleanup jobs.
- CI: `docker compose config`, ESLint, and per-service test suites (jest + testcontainers).
