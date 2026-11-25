// Tenant portal, end to end over real HTTP (cookies and PDF downloads need a
// real response): sign in with an account number and an SMS code, no website
// account, then read invoices and download invoice and statement PDFs.
//
// HQ is a fake HTTP server here, so no SMS is ever sent. Runs against the
// database in .env, like tests/api.test.ts; it removes the rows it makes.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server, getStore } from '@tylix/core'
import { createTestClient, type TestClient } from '@tylix/cli/testing'
import { TenantSession } from '../app/models/TenantSession.js'

const TENANT_ID = 4242
const ACCOUNT = 'BB-TEST-01'
const PHONE = '0712345678'
const CODE = '123456'

let client: TestClient
let hq: http.Server
let app: http.Server
let base = ''
const hqCalls: string[] = []
const hqBodies: Record<string, any>[] = []
let repairs: Record<string, any>[] = []

const party = {
    issuer: { name: 'Barani Better Homes Ltd', address: 'Nairobi', phone: '0700 000 000', email: 'accounts@example.com' },
    tenant: { name: 'Test Tenant', account_number: ACCOUNT, phone: PHONE, email: null },
    unit: { name: 'A1', type: 'Bedsitter' },
    property: { name: 'Test Court', location: 'Nairobi' },
    pay: { paybill: '123456', account_number: ACCOUNT },
}

function fakeHq(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://hq')
        const path = url.pathname.replace('/api/bbhomes/v1', '')
        hqCalls.push(`${req.method} ${path}${url.search}`)
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
        }
        if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: 'bad token' })

        const body = raw ? JSON.parse(raw) : {}
        if (path === '/tenants/verification') {
            return send(202, { sent: true, message: 'ok' })
        }
        if (path === '/tenants/verification/confirm') {
            if (body.account_number === ACCOUNT && body.code === CODE) {
                return send(200, { data: { tenant_id: TENANT_ID, name: 'Test Tenant', account_number: ACCOUNT, phone: PHONE } })
            }
            return send(422, { errors: { code: ['That code is wrong or has expired.'] } })
        }
        // Every tenant read must be for the tenant the session belongs to.
        if (!path.startsWith(`/tenants/${TENANT_ID}/`)) return send(404, { error: 'Tenant not found.' })
        const rest = path.slice(`/tenants/${TENANT_ID}`.length)
        if (rest === '/summary') {
            return send(200, { data: { ...party, lease: null, balances: { rent: 5000, deposit: 0, utilities: 0, lock_fee: 0, agent_fee: 0, total: 5000 }, wallet_balance: 0 } })
        }
        if (rest === '/invoices') {
            return send(200, { data: [{ id: 7, invoice_number: 'INV7', type: 'income', status: 'unpaid', invoiced_at: '2026-11-01', due_at: '2026-11-05', total: 5000, balance: 5000 }] })
        }
        if (rest === '/invoices/7') {
            return send(200, { data: {
                ...party, id: 7, invoice_number: 'INV7', type: 'income', status: 'partial', invoiced_at: '2026-11-01', due_at: '2026-11-05',
                total: 8000, paid: 3000, balance: 5000, voided: null,
                items: [{ name: 'Rent', description: 'November 2026', quantity: 1, price: 8000, total: 8000 }],
                payments: [{ paid_at: '2026-11-02T09:00:00+03:00', amount: 3000, received: 3000, to_credit: 0, method: 'mpesa', reference: 'ABC123', receipt_number: '99' }],
            } })
        }
        if (rest.startsWith('/invoices/')) return send(404, { error: 'Invoice not found.' })
        if (rest === '/statement') {
            return send(200, { data: {
                ...party, from: url.searchParams.get('from'), to: url.searchParams.get('to'),
                opening_balance: 0, closing_balance: 5000, total_charges: 8000, total_payments: 3000, total_other_credits: 0, wallet_balance: 0,
                entries: [
                    { date: '2026-11-01', type: 'invoice', description: 'Rent for November 2026', reference: 'INV INV7', debit: 8000, credit: 0, balance: 8000 },
                    { date: '2026-11-02', type: 'payment', description: 'Payment (M-Pesa) · INV INV7', reference: 'ABC123', debit: 0, credit: 3000, balance: 5000 },
                ],
            } })
        }
        if (rest === '/payments') return send(200, { data: [] })
        if (rest === '/maintenance' && req.method === 'GET') return send(200, { data: repairs })
        if (rest === '/maintenance' && req.method === 'POST') {
            hqBodies.push(body)
            const row = { id: 900 + repairs.length, ...body, status: 'submitted', source: 'tenant_portal', created_at: '2026-11-25T10:00:00+03:00', can_cancel: true }
            repairs = [row, ...repairs]
            return send(201, { data: row })
        }
        const cancel = rest.match(/^\/maintenance\/(\d+)\/cancel$/)
        if (cancel && req.method === 'POST') {
            const row = repairs.find((r) => r.id === Number(cancel[1]))
            if (!row) return send(404, { error: 'Request not found.' })
            row.status = 'cancelled'
            row.can_cancel = false
            return send(200, { data: row })
        }
        return send(404, { error: 'not here' })
    })
}

async function listen(server: http.Server): Promise<number> {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
    return (server.address() as AddressInfo).port
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' }
    if (init.body) headers['Content-Type'] = 'application/json'
    if (init.cookie) headers.Cookie = init.cookie
    return fetch(base + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, redirect: 'manual' })
}

before(async () => {
    hq = http.createServer(fakeHq).listen(0)
    process.env.HQ_URL = `http://127.0.0.1:${await listen(hq)}`
    process.env.HQ_API_TOKEN = 'test-token'
    // The app must not text anyone: HQ "sends" the code instead.
    delete process.env.ASHMIF_API_KEY
    delete process.env.ASHMIF_SENDER_ID

    client = await createTestClient()
    // createTestClient loads .env, which may set the real HQ values again.
    process.env.HQ_URL = `http://127.0.0.1:${(hq.address() as AddressInfo).port}`
    process.env.HQ_API_TOKEN = 'test-token'
    delete process.env.ASHMIF_API_KEY
    delete process.env.ASHMIF_SENDER_ID

    const appInfo = client.app as { router: unknown; serverOptions?: Record<string, unknown> }
    app = new Server(appInfo.router as never, { ...(appInfo.serverOptions ?? {}), autoPort: false }).listen(0, () => {}) as unknown as http.Server
    base = `http://127.0.0.1:${await listen(app)}`
    process.env.TRUSTED_ORIGINS = base
    await resetSignInLimits()
})

// The sign-in limits are counted in the app's store, so earlier runs from
// this machine would otherwise use them up (see TenantController).
async function resetSignInLimits() {
    const window = 15 * 60_000
    const start = Math.floor(Date.now() / window) * window
    const keys = [
        ...['127.0.0.1', '::1', '::ffff:127.0.0.1'].flatMap((ip) => [`tenant-login-ip:${ip}`, `tenant-confirm-ip:${ip}`]),
        `tenant-login-account:${ACCOUNT.toLowerCase()}`,
        `tenant-confirm-account:${ACCOUNT.toLowerCase()}`,
    ]
    for (const key of keys) await getStore().delete(`ratelimit:${key}:${start}`)
    const hour = 60 * 60_000
    await getStore().delete(`ratelimit:tenant-maintenance:t:${TENANT_ID}:${Math.floor(Date.now() / hour) * hour}`)
}

after(async () => {
    for (const row of (await TenantSession.query().where('properman_tenant_id', TENANT_ID).get()) as Array<{ id: number }>) {
        await TenantSession.delete(row.id)
    }
    await new Promise((resolve) => app?.close(resolve))
    await new Promise((resolve) => hq?.close(resolve))
    await client?.close()
})

test('a tenant signs in with account number and SMS code, without a website account', async () => {
    // Signed out: the portal says so, and data routes refuse without a 401
    // (a 401 would make the frontend try to refresh a website session).
    let res = await call('/api/tenant')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { enabled: true, signedIn: false })

    res = await call('/api/tenant/invoices')
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, 'TENANT_SIGNED_OUT')

    res = await call('/api/tenant/statement/pdf?from=2026-01-01')
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/tenant')

    // Step 1: request a code. HQ is asked to deliver it (no Ashmif here).
    res = await call('/api/tenant/login', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: '0712 345 678' }) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).sent, true)
    assert.ok(hqCalls.includes('POST /tenants/verification'))

    // A wrong code is a field error and starts no session.
    res = await call('/api/tenant/login/confirm', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: PHONE, code: '000000' }) })
    assert.equal(res.status, 422)
    assert.equal(res.headers.get('set-cookie'), null)

    // Step 2: the right code sets an HttpOnly cookie scoped to the tenant API.
    res = await call('/api/tenant/login/confirm', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: PHONE, code: CODE }) })
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^bb_tenant=[^;]+/)
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /Path=\/api\/tenant/i)
    assert.match(setCookie, /SameSite=Lax/i)
    const cookie = setCookie.split(';')[0]

    // Only a hash of the token is stored.
    const token = cookie.split('=')[1]
    const stored = (await TenantSession.query().where('properman_tenant_id', TENANT_ID).first()) as Record<string, unknown>
    assert.ok(stored)
    assert.notEqual(stored.token_hash, token)

    res = await call('/api/tenant', { cookie })
    const status = await res.json()
    assert.equal(status.signedIn, true)
    assert.equal(status.summary.tenant.account_number, ACCOUNT)

    res = await call('/api/tenant/invoices', { cookie })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).data[0].id, 7)

    // The invoice PDF.
    res = await call('/api/tenant/invoices/7/pdf', { cookie })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="invoice-INV7\.pdf"/)
    const invoiceBytes = Buffer.from(await res.arrayBuffer())
    assert.equal(invoiceBytes.subarray(0, 5).toString(), '%PDF-')

    res = await call('/api/tenant/invoices/7/pdf?download=1', { cookie })
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/)
    await res.arrayBuffer()

    // Someone else's invoice: HQ doesn't find it for this tenant.
    res = await call('/api/tenant/invoices/8/pdf', { cookie })
    assert.equal(res.status, 404)

    // The statement PDF, and a period it refuses.
    res = await call('/api/tenant/statement/pdf?from=2026-01-01&to=2026-11-25', { cookie })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.match(res.headers.get('content-disposition') ?? '', /statement-BB-TEST-01-2026-01-01-to-2026-11-25\.pdf/)
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
    assert.ok(hqCalls.includes(`GET /tenants/${TENANT_ID}/statement?from=2026-01-01&to=2026-11-25`))

    res = await call('/api/tenant/statement/pdf?from=2026-11-25&to=2026-01-01', { cookie })
    assert.equal(res.status, 422)
    res = await call('/api/tenant/statement/pdf?from=2015-01-01&to=2026-01-01', { cookie })
    assert.equal(res.status, 422)

    // Every HQ read was for the signed-in tenant.
    assert.ok(hqCalls.filter((c) => c.startsWith('GET /tenants/')).every((c) => c.startsWith(`GET /tenants/${TENANT_ID}/`)))

    // Signing out ends the session server-side, not just in the browser.
    res = await call('/api/tenant/logout', { method: 'POST', cookie })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('set-cookie') ?? '', /bb_tenant=;.*Max-Age=0/i)
    res = await call('/api/tenant/invoices', { cookie })
    assert.equal(res.status, 403)
})

test('a made-up session cookie is refused', async () => {
    const res = await call('/api/tenant/invoices', { cookie: 'bb_tenant=not-a-real-token' })
    assert.equal(res.status, 403)
})

test('a tenant reports a repair, which goes to HQ for their own tenancy, and can cancel it', async () => {
    let res = await call('/api/tenant/maintenance')
    assert.equal(res.status, 403)
    res = await call('/api/tenant/maintenance', { method: 'POST', body: JSON.stringify({ title: 'Leak' }) })
    assert.equal(res.status, 403)

    await call('/api/tenant/login', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: PHONE }) })
    res = await call('/api/tenant/login/confirm', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: PHONE, code: CODE }) })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]

    // Checked here before HQ is asked.
    const before = hqBodies.length
    res = await call('/api/tenant/maintenance', { method: 'POST', cookie, body: JSON.stringify({ title: 'x', category: 'magic', priority: 'now' }) })
    assert.equal(res.status, 422)
    const errors = (await res.json()).errors
    assert.ok(errors.title && errors.description && errors.category && errors.priority)
    assert.equal(hqBodies.length, before)

    // A tenant id in the body is ignored: HQ is asked for the session's tenant.
    res = await call('/api/tenant/maintenance', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ title: '  Kitchen sink leaking ', description: 'Water under the sink since Monday.', category: 'plumbing', priority: 'high', tenant_id: 1 }),
    })
    assert.equal(res.status, 201)
    const created = (await res.json()).data
    assert.equal(created.status, 'submitted')
    assert.ok(hqCalls.includes(`POST /tenants/${TENANT_ID}/maintenance`))
    const sent = hqBodies[hqBodies.length - 1]
    assert.equal(sent.title, 'Kitchen sink leaking')
    assert.equal(sent.tenant_id, undefined)
    // No contact given: the phone on the session is passed on for the technician.
    assert.equal(sent.reported_contact, PHONE)

    res = await call('/api/tenant/maintenance', { cookie })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).data[0].id, created.id)

    res = await call(`/api/tenant/maintenance/${created.id}/cancel`, { method: 'POST', cookie })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).data.status, 'cancelled')
    res = await call('/api/tenant/maintenance/12345/cancel', { method: 'POST', cookie })
    assert.equal(res.status, 404)

    await call('/api/tenant/logout', { method: 'POST', cookie })
})
