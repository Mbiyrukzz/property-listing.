// Property listings are Barani Better Homes' own (made in the admin).
// Properman-synced properties only show up as vacant units, though their
// page still opens from a vacant unit card.
//
// Runs against the database in .env, like tests/api.test.ts; it removes the
// rows it makes.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestClient, type TestClient } from '@tylix/cli/testing'
import { Listing } from '../app/models/Listing.js'
import { ListingUnit } from '../app/models/ListingUnit.js'
import { upsertProperty } from '../app/services/ListingSync.js'

const TOKEN = 'zqlistingtest'
const EXTERNAL_ID = 990001
const FUTURE = '2099-01-01T00:00:00.000Z'

let client: TestClient
let ownId = 0
let hqId = 0

async function cleanUp() {
    const rows = (await Listing.query().where('search_text', 'LIKE', `%${TOKEN}%`).get()) as { id: number }[]
    for (const row of rows) {
        const units = (await ListingUnit.where('property_id', row.id).get()) as { id: number }[]
        for (const unit of units) await ListingUnit.delete(unit.id)
        await Listing.delete(row.id)
    }
}

before(async () => {
    client = await createTestClient()
    await cleanUp()

    const own = (await Listing.create({
        source: 'manual',
        slug: `${TOKEN}-own`,
        title: `Own house ${TOKEN}`,
        purpose: 'rent',
        category: 'house',
        location: 'Nairobi',
        price: 50000,
        status: 'available',
        is_published: 1,
        is_featured: 1,
        published_at: FUTURE,
        search_text: `own house ${TOKEN}`,
    })) as { id: number }
    ownId = own.id

    hqId = await upsertProperty({
        id: EXTERNAL_ID,
        name: `HQ Court ${TOKEN}`,
        category: 'apartment',
        location: 'Mombasa',
        description: 'Synced from Properman.',
        published_at: FUTURE,
        units: [
            { id: EXTERNAL_ID, name: 'B1', type: '1 Bedroom', bedrooms: 1, bathrooms: 1, rent: 15000, vacant: true },
            { id: EXTERNAL_ID + 1, name: 'B2', type: '1 Bedroom', bedrooms: 1, bathrooms: 1, rent: 15000, vacant: false },
        ],
    } as any)
})

after(async () => {
    await cleanUp()
    await client.close()
})

test('search lists only our own properties, never Properman ones', async () => {
    const res = await client.get(`/api/listings?q=${TOKEN}`)
    assert.equal(res.status, 200)
    const ids = res.data.data.map((l: { id: number }) => l.id)
    assert.deepEqual(ids, [ownId])
})

test('the homepage property sections leave Properman out, its vacant units stay', async () => {
    const res = await client.get('/api/listings/home')
    assert.equal(res.status, 200)
    const featured = res.data.featured.map((l: { id: number }) => l.id)
    const recent = res.data.recent.map((l: { id: number }) => l.id)
    assert.ok(recent.includes(ownId))
    assert.ok(!featured.includes(hqId))
    assert.ok(!recent.includes(hqId))
})

test('Properman vacant units are listed and open their property page', async () => {
    let res = await client.get(`/api/listings/vacant-units?q=${TOKEN}`)
    assert.equal(res.status, 200)
    assert.equal(res.data.meta.total, 1)
    const unit = res.data.data[0]
    assert.equal(unit.name, 'B1')
    assert.equal(unit.listing.id, hqId)

    res = await client.get(`/api/listings/${unit.listing.slug}`)
    assert.equal(res.status, 200)
    assert.equal(res.data.data.id, hqId)
    // "Similar" on that page is our own listings only.
    assert.ok(res.data.similar.every((l: { fromProperman: boolean }) => !l.fromProperman))
})
