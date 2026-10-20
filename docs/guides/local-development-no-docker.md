# Local development without Docker

[local-development.md](./local-development.md) describes the one-command path
(`npm run dev:stack`): the official Supabase CLI runs Supabase's own containers,
and Docker Compose runs the frontend, API, paper runner, and backtest worker.
That is the lowest-overhead path when Docker Desktop is available.

This guide is the alternative for a machine without Docker (locked-down laptop,
no admin rights, Docker Desktop won't start, etc). It swaps the local Supabase
container for a free **hosted** Supabase project and runs every process
directly with Node — nothing else about the app changes: same migrations,
schema, RLS, and Alpaca key handling as the Docker path.

## Prerequisites

- Node.js 22+
- A free [Supabase](https://supabase.com) project (replaces the local Supabase container)
- Optional: a free [Alpaca](https://alpaca.markets) paper account for real
  market data/order testing — without it everything still works in sim mode

## 1. Create a hosted Supabase project

In the Supabase dashboard, create a project and note:

- **Project URL** and **anon key** — Settings → API
- **service_role key** — Settings → API (treat as the most sensitive value you'll copy)
- **DATABASE_URL** — Connect → "Session pooler" connection string, with the
  database password you set when creating the project
- Optional: **root CA cert** — Database → SSL Configuration → Download (lets
  the migration tool verify the server instead of trusting any certificate)

## 2. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

Skip the repo-root `npm install` / `npm run setup` — those only install and
configure the Docker-based Supabase CLI stack, which this path doesn't use.

## 3. Configure the backend

```bash
cd backend
cp .env.example .env
```

Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`DATABASE_URL` (and `DATABASE_CA_CERT` if you downloaded it) from step 1.
Leave `EXECUTION_TARGET=sim` unless you're also providing your own Alpaca
paper keys — see "Market data" below.

## 4. Apply the schema

```bash
npm run db:migrate   # applies every supabase/migrations/*.sql in order, directly over DATABASE_URL
npm run db:status    # confirms what's applied
```

This is the same migration runner the Docker path uses underneath — it just
targets your hosted project's Postgres instead of a local one. No Supabase CLI
or Docker involved.

## 5. Configure the frontend

```bash
cd frontend
cp .env.example .env.local
```

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the same
project's values. Leave the `NEXT_PUBLIC_*_API_BASE_URL` defaults as-is —
they already point at the ports the backend processes use below.

## 6. Create your account and activate it

There's no automatic local-lead bootstrap on a hosted project (that's specific
to `dev:stack`). Instead:

1. Start the frontend (next section) and sign up through the app's sign-up
   page. This creates the Supabase auth user and, via the `0008` migration's
   trigger, a `pending` row in `public.app_users`.
2. In the Supabase dashboard's SQL editor, activate yourself as a lead:

   ```sql
   update public.app_users
   set membership_status = 'active', role = 'lead'
   where email = 'you@example.com';
   ```

Any lead can activate further members the same way afterward (see
[local-development.md § Membership](./local-development.md#membership)).

## 7. Run the processes

Each in its own terminal:

```bash
cd backend && npm run dev:paper-trading   # :8080 — sim book by default
cd backend && npm run dev:api             # :8082 — backtest/control API
cd backend && npm run dev:worker          # backtest worker (needed to run backtests)
cd frontend && npm run dev                # :3000
```

- App: http://localhost:3000
- Paper runner: http://localhost:8080
- API: http://localhost:8082

`dev:real-trading` (:8081) is deliberately left out of this list, same as the
Docker stack — promoting to real-money trading is its own explicit step, not
a side effect of starting the stack.

## Market data

Same rules as the Docker path:

- No Alpaca keys → sim and backtests replay the local bar cache. Seed it with
  `npm run data:pull` (see [local-development.md § Seeding replay data](./local-development.md#seeding-replay-data) —
  that command already talks to a hosted API/Supabase and needs no Docker).
- Your own free Alpaca keys in `backend/.env` → backtests and the paper
  runner pull real bars/orders against **your own** account.
- The club's shared Alpaca account is refused at boot by
  `backend/src/core/broker/brokerPreflight.ts` outside the `aws-prod` origin —
  that check runs inside the backend process itself, so it applies here exactly
  as it does under Docker.

## Everything else

Ports, data safety expectations, membership model, and the paper/live
boundary are identical to the Docker path — see the rest of
[local-development.md](./local-development.md). The only things this guide
replaces are: the local Supabase container (→ hosted project), `dev:stack`'s
local-lead bootstrap (→ sign up + one SQL update), and running processes in
containers (→ running them directly with `npm run dev:*`).
