import type { Scheduler } from '@tylix/core'
import { syncAll } from './services/ListingSync.js'
import { pruneTenantSessions } from './services/TenantAuth.js'
import { pruneLandlordSessions } from './services/LandlordAuth.js'

export async function schedule(scheduler: Scheduler) {
  // The safety net behind Properman's webhooks: re-read every published
  // listing and take off the site whatever Properman no longer publishes.
  const minutes = Math.max(1, Number(process.env.HQ_SYNC_MINUTES ?? 10) || 10)
  scheduler.every(`${minutes}m`, async () => {
    await syncAll('schedule')
  })

  // Portal sessions that expired or went idle (app/services/PortalSession).
  scheduler.every('6h', async () => {
    await pruneTenantSessions()
    await pruneLandlordSessions()
  })
}
