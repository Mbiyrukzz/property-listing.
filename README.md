# Barani Better Homes

The public real-estate site: rentals, sales, land and commercial listings,
customer accounts, a tenant portal and the staff dashboard at `/admin`.
Built with Tylix (.tyx pages on a Tylix backend).

HQ (hq.baranibetterhomes.com) stays the source of truth for properties, units, vacancies,
tenancies and rent. Barani Better Homes shows what HQ publishes and handles the
marketing side: enquiries, viewings, applications and customer accounts.
Sales, land and other listings that aren't in HQ are added in
`/admin/listings`.

## Going live

Barani Better Homes runs at **https://baranibetterhomes.com**. HQ, the property
management system staff already use (code in the `properman/` folder), stays at **https://hq.baranibetterhomes.com**.
The two servers talk to each other directly; visitors only ever see
baranibetterhomes.com.

```
 visitor ──► baranibetterhomes.com (Barani Better Homes)
                 │  ▲
   reads listings │  │ "property 12 changed" (signed webhook)
   & tenant data  ▼  │
             hq.baranibetterhomes.com (HQ)
```

Both apps share a token and a webhook secret: two long random strings
(`openssl rand -hex 32`), never committed.

| Barani Better Homes `.env` (baranibetterhomes.com)  | HQ `.env` (hq.baranibetterhomes.com) |
| --------------------------------------- | ------------------------------------------- |
| `APP_URL=https://baranibetterhomes.com` | |
| `HQ_URL=https://hq.baranibetterhomes.com` | |
| `HQ_API_TOKEN=<token>`           | `BBHOMES_API_TOKEN=<token>` |
| `HQ_WEBHOOK_SECRET=<secret>`     | `BBHOMES_WEBHOOK_SECRET=<secret>` |
| | `BBHOMES_WEBHOOK_URL=https://baranibetterhomes.com/api/integrations/hq/webhook` |

Order of rollout (HQ is live, so it goes first and stays inert):

1. **HQ:** deploy the new code, then `php artisan migrate` (it only
   adds nullable listing columns) and `php artisan config:cache`. Until the
   `BBHOMES_*` values are set, nothing changes for staff: the API answers 503
   and no webhooks are queued.
2. **Barani Better Homes:** deploy, set `.env` as above, then `npx tylix migrate` and
   `npx tylix db:seed` (roles and the About/Terms/Privacy pages; never
   `SEED_DEMO` in production). Start the queue worker and scheduler (below).
3. **Connect:** add the `BBHOMES_*` values to HQ's `.env`, run
   `php artisan config:cache`, and make sure HQ's queue worker runs.
4. **Check:** on `/admin/integration` press "Sync now" (it should say
   "0 listing(s) up to date" before anything is published), then publish
   one property in HQ and watch it appear.

Tenant payments still go through HQ's existing M-Pesa setup: Barani Better Homes
asks HQ to start the STK push, and Safaricom's callbacks keep going to
hq as they do today. Tenant verification codes are sent by HQ's SMS
provider.

How listings flow:

1. In HQ, open a property and use the **Barani Better Homes website** panel: tick
   "Show this property on Barani Better Homes", pick a category, and untick any vacant
   unit to hold back.
2. HQ queues a webhook on every change to a published property or its
   units; Barani Better Homes verifies it and re-reads that property from HQ's API.
3. Vacant units appear under rentals; a unit disappears when a tenant moves
   in and returns when they move out; unpublishing removes the listing.
4. A full re-sync runs every `HQ_SYNC_MINUTES` as a safety net. Staff
   can also run one from `/admin/integration`, which shows the sync log.

Only names, locations, descriptions, photos, unit types and rents leave
HQ for listings. Tenant data is read only for a signed-in tenant who
has linked their tenancy by SMS code (see `/tenant`).

## Processes

```sh
npm run dev              # web server (dev)
npx tylix queue:work     # webhook syncs and staff notification emails
npx tylix schedule:work  # the periodic full sync
```

In HQ, its queue worker (`php artisan queue:work`) must run too,
unless `QUEUE_CONNECTION=sync`, or webhooks are never sent.

## Staff and roles

Roles are defined in `app/permissions.ts` and synced by `tylix db:seed`:

| Role     | Can                                                            |
| -------- | -------------------------------------------------------------- |
| `admin`  | Everything below, plus listings, agents, reports, sync, users and roles |
| `agent`  | Enquiries, viewings, applications, customers; feature listings |
| `editor` | Site content and pages, news posts, sync status                |
| `member` | Every signed-in customer (no admin access)                     |

Make the first administrator after they register:

```sh
npx tylix permission:assign admin someone@example.com
```

After that, roles are managed on `/admin/access`.

For local development, `SEED_DEMO=true npx tylix db:seed` adds example
sale, land and commercial listings and an agent. Never run it in production.

## Run it

```sh
npm run dev        # http://localhost:3000, reloads on save
npm test           # API tests in tests/
npm run doctor     # checks config, database, migrations and frontend
npm run tinker     # a REPL with your models, services and request()
npm run build      # typecheck and production bundles
npm start          # production server (after build and migrate)
```

## Layout

```
app/pages/            .tyx pages (the file name is the URL) and components/
app/routes/           API routes (web.ts); everything under /api/
app/controllers/      request handlers
app/models/           one class per table
app/services/         business logic shared by controllers and jobs
app/middleware/       functions that run around requests
app/validators/       rules for incoming data
app/jobs/             background work (tylix queue:work)
app/observers/        code that runs when models change
app/traits/           reusable model behaviour
app/mail/             mailables and the mailer
app/Features/         CRUD features made by tylix make:feature
app/schedule.ts         scheduled tasks (tylix schedule:work)
app/seeders/          sample data (tylix db:seed)
database/migrations/  schema changes (tylix migrate)
tests/                API tests
public/               static files, served as-is
```

Each folder has a README saying what goes there and which command makes it.

## Make things

```sh
tylix make:feature Invoice title:string total:number   # model, migration, CRUD API
tylix make:page Reports --auth                          # a page and its route
tylix make:component StatCard
tylix make:service Billing
tylix make:controller Invoice
tylix make:job SendInvoice                              # background job
tylix make:observer Audit --model User                  # model lifecycle hooks
tylix make:trait HasSlug                                # reusable model behaviour
tylix make:channel chat                                 # live channel + demo page
```
# property-listing.
