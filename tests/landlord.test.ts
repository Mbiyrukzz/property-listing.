// Landlord portal, end to end over real HTTP: the same sign-in as tenants
// (account number + SMS code, no website account), then the portfolio,
// units, payouts and repairs, and the payout and income statement PDFs.
//
// HQ is a fake HTTP server here, so no SMS is ever sent. Runs against the
// database in .env, like tests/tenant.test.ts; it removes the rows it makes.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server, getStore } from '@tylix/core'
import { createTestClient, type TestClient } from '@tylix/cli/testing'
import { LandlordSession } from '../app/models/LandlordSession.js'

const LANDLORD_ID = 5151
const ACCOUNT = '654321'
const PHONE = '0722000111'
const CODE = '246810'

let client: TestClient
let hq: http.Server
let app: http.Server
let base = ''
const hqCalls: string[] = []

const issuer = { name: 'Barani Better Homes Ltd', address: 'Nairobi', phone: '0700 000 000', email: 'accounts@example.com' }
const landlordBlock = { id: LANDLORD_ID, name: 'Test Landlord', account_number: ACCOUNT, phone: PHONE, email: 'owner@example.com' }

const breakdown = {
    collected: 20000, management_fee_percent: 10, management_fee: 2000, expenses: 1500, credit_notes: 0,
    loan_repayment: 0, loan_description: '', other: 500, net_payout: 17000, paid: 17000, held_back: 0,
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
        if (path === '/landlords/verification') return send(202, { sent: true, message: 'ok' })
        if (path === '/landlords/verification/confirm') {
            if (body.account_number === ACCOUNT && body.code === CODE) {
                return send(200, { data: { landlord_id: LANDLORD_ID, name: 'Test Landlord', account_number: ACCOUNT, phone: PHONE } })
            }
            return send(422, { errors: { code: ['That code is wrong or has expired.'] } })
        }
        if (!path.startsWith(`/landlords/${LANDLORD_ID}/`)) return send(404, { error: 'Landlord not found.' })
        const rest = path.slice(`/landlords/${LANDLORD_ID}`.length)

        if (rest === '/summary') {
            return send(200, { data: {
                landlord: landlordBlock,
                payout: { mode: 'personal', destination: '072••••111' },
                totals: { properties: 1, units: 2, occupied: 1, vacant: 1, occupancy_rate: 50, rent_roll: 10000, potential_rent: 22000, vacancy_loss: 12000, arrears: 2500, collected_since_payout: 8000, paid_this_year: 17000, paid_all_time: 17000, open_maintenance: 1, payouts_processing: 0 },
                properties: [{ id: 77001, name: 'Test Court', location: 'Nairobi', listed_online: true, units: 2, occupied: 1, vacant: 1, rent_roll: 10000, potential_rent: 22000, arrears: 2500, management_fee_percent: 10, collected_since_payout: 8000, estimated_fee: 800, payout_day: 5, last_payout: { date: '2026-11-05', amount: 17000 } }],
                monthly: [{ month: '2026-11', paid: 17000 }],
            } })
        }
        if (rest === '/units') {
            return send(200, { data: [
                { id: 1, property: { id: 77001, name: 'Test Court' }, name: 'A1', type: 'Bedsitter', rent: 10000, vacant: false, vacant_since: null, listed_online: false, tenant: { name: 'Jane', arrears: 2500 } },
                { id: 2, property: { id: 77001, name: 'Test Court' }, name: 'A2', type: '2 Bedrooms', rent: 12000, vacant: true, vacant_since: '2026-11-01', listed_online: true, tenant: null },
            ] })
        }
        if (rest === '/payouts') {
            return send(200, { data: [{ id: 31, property: { id: 77001, name: 'Test Court' }, period: 'November 2026', status: 'paid', total_collected: 20000, total_deductions: 3500, net_payout: 17000, paid: 17000, paid_at: '2026-11-05' }] })
        }
        if (rest === '/payouts/31') {
            return send(200, { data: {
                id: 31, property: { id: 77001, name: 'Test Court' }, period: 'November 2026', period_start: '2026-10-05', period_end: '2026-11-05',
                status: 'paid', total_collected: 20000, total_deductions: 3500, net_payout: 17000, paid: 17000, paid_at: '2026-11-05',
                breakdown,
                expenses: [{ description: 'Security', amount: 1500 }],
                credit_notes: [],
                units: [{ name: 'A1', tenant: 'Jane', rent: 10000, payments: 10000, balance: 2500 }, { name: 'A2', tenant: 'Vacant', rent: 12000, payments: 0, balance: 0 }],
                notes: '', issuer, landlord: landlordBlock,
            } })
        }
        if (rest.startsWith('/payouts/')) return send(404, { error: 'Payout not found.' })
        if (rest === '/statement') {
            const entry = { id: 31, date: '2026-11-05', property: 'Test Court', period: 'November 2026', ...breakdown }
            return send(200, { data: {
                from: url.searchParams.get('from'), to: url.searchParams.get('to'),
                entries: [entry],
                totals: { collected: 20000, management_fee: 2000, expenses: 1500, credit_notes: 0, loan_repayment: 0, other: 500, net_payout: 17000, paid: 17000, held_back: 0 },
                by_property: [{ property: 'Test Court', payouts: 1, ...breakdown }],
                processing: 0, issuer, landlord: landlordBlock,
            } })
        }
        if (rest === '/maintenance') {
            return send(200, { data: [{ id: 5, property: 'Test Court', unit: 'A1', title: 'Leaking tap', status: 'acknowledged', open: true, priority: 'high', category: 'plumbing', source: 'tenant_portal', created_at: '2026-11-20T10:00:00+03:00' }] })
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

function useFakeHq() {
    process.env.HQ_URL = `http://127.0.0.1:${(hq.address() as AddressInfo).port}`
    process.env.HQ_API_TOKEN = 'test-token'
    // The app must not text anyone: HQ "sends" the code instead.
    delete process.env.ASHMIF_API_KEY
    delete process.env.ASHMIF_SENDER_ID
}

before(async () => {
    hq = http.createServer(fakeHq).listen(0)
    await listen(hq)
    useFakeHq()
    client = await createTestClient()
    // createTestClient loads .env, which may set the real HQ values again.
    useFakeHq()

    const appInfo = client.app as { router: unknown; serverOptions?: Record<string, unknown> }
    app = new Server(appInfo.router as never, { ...(appInfo.serverOptions ?? {}), autoPort: false }).listen(0, () => {}) as unknown as http.Server
    base = `http://127.0.0.1:${await listen(app)}`
    process.env.TRUSTED_ORIGINS = base

    // The sign-in limits live in the app's store; earlier runs would use them up.
    const window = 15 * 60_000
    const start = Math.floor(Date.now() / window) * window
    const keys = [
        ...['127.0.0.1', '::1', '::ffff:127.0.0.1'].flatMap((ip) => [`landlord-login-ip:${ip}`, `landlord-confirm-ip:${ip}`]),
        `landlord-login-account:${ACCOUNT}`,
        `landlord-confirm-account:${ACCOUNT}`,
    ]
    for (const key of keys) await getStore().delete(`ratelimit:${key}:${start}`)
})

after(async () => {
    for (const row of (await LandlordSession.query().where('properman_landlord_id', LANDLORD_ID).get()) as Array<{ id: number }>) {
        await LandlordSession.delete(row.id)
    }
    await new Promise((resolve) => app?.close(resolve))
    await new Promise((resolve) => hq?.close(resolve))
    await client?.close()
})

test('a landlord signs in like a tenant and reads their portfolio, payouts and repairs', async () => {
    let res = await call('/api/landlord')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { enabled: true, signedIn: false })

    for (const path of ['/api/landlord/units', '/api/landlord/payouts', '/api/landlord/maintenance']) {
        res = await call(path)
        assert.equal(res.status, 403, path)
        assert.equal((await res.json()).code, 'LANDLORD_SIGNED_OUT')
    }
    res = await call('/api/landlord/payouts/31/pdf')
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/landlord')

    res = await call('/api/landlord/login', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: '0722 000 111' }) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).sent, true)
    assert.ok(hqCalls.includes('POST /landlords/verification'))

    res = await call('/api/landlord/login/confirm', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: PHONE, code: '111111' }) })
    assert.equal(res.status, 422)
    assert.equal(res.headers.get('set-cookie'), null)

    res = await call('/api/landlord/login/confirm', { method: 'POST', body: JSON.stringify({ account_number: ACCOUNT, phone: PHONE, code: CODE }) })
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^bb_landlord=[^;]+/)
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /Path=\/api\/landlord/i)
    assert.match(setCookie, /SameSite=Lax/i)
    const cookie = setCookie.split(';')[0]
    const token = cookie.split('=')[1]

    const stored = (await LandlordSession.query().where('properman_landlord_id', LANDLORD_ID).first()) as Record<string, unknown>
    assert.ok(stored)
    assert.notEqual(stored.token_hash, token)

    // A landlord session is not a tenant session.
    res = await call('/api/tenant/invoices', { cookie: `bb_tenant=${token}` })
    assert.equal(res.status, 403)

    res = await call('/api/landlord', { cookie })
    const status = await res.json()
    assert.equal(status.signedIn, true)
    assert.equal(status.summary.landlord.account_number, ACCOUNT)
    assert.equal(status.summary.totals.vacant, 1)
    assert.ok('listing_slug' in status.summary.properties[0])

    res = await call('/api/landlord/units', { cookie })
    assert.equal(res.status, 200)
    const units = (await res.json()).data
    assert.equal(units.filter((u: { vacant: boolean }) => u.vacant).length, 1)

    res = await call('/api/landlord/payouts', { cookie })
    assert.equal((await res.json()).data[0].id, 31)

    res = await call('/api/landlord/maintenance', { cookie })
    assert.equal((await res.json()).data[0].title, 'Leaking tap')

    // The payout PDF, and one that isn't theirs.
    res = await call('/api/landlord/payouts/31/pdf', { cookie })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="payout-Test-Court-November-2026\.pdf"/)
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
    res = await call('/api/landlord/payouts/32/pdf?download=1', { cookie })
    assert.equal(res.status, 404)

    // The income statement PDF, and periods it refuses.
    res = await call('/api/landlord/statement/pdf?from=2026-01-01&to=2026-11-25&download=1', { cookie })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="income-statement-654321-2026-01-01-to-2026-11-25\.pdf"/)
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
    assert.ok(hqCalls.includes(`GET /landlords/${LANDLORD_ID}/statement?from=2026-01-01&to=2026-11-25`))
    res = await call('/api/landlord/statement/pdf?from=2026-11-25&to=2026-01-01', { cookie })
    assert.equal(res.status, 422)
    res = await call('/api/landlord/statement/pdf?from=2015-01-01&to=2026-01-01', { cookie })
    assert.equal(res.status, 422)

    // Every HQ read was for the signed-in landlord.
    assert.ok(hqCalls.filter((c) => c.startsWith('GET /landlords/')).every((c) => c.startsWith(`GET /landlords/${LANDLORD_ID}/`)))

    res = await call('/api/landlord/logout', { method: 'POST', cookie })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('set-cookie') ?? '', /bb_landlord=;.*Max-Age=0/i)
    res = await call('/api/landlord/units', { cookie })
    assert.equal(res.status, 403)
})

test('a made-up landlord cookie is refused', async () => {
    const res = await call('/api/landlord/payouts', { cookie: 'bb_landlord=not-a-real-token' })
    assert.equal(res.status, 403)
})
