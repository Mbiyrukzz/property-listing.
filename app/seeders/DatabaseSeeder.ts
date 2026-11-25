import { seed as seedPermissions } from './PermissionSeeder.js'
import { seed as seedDemo } from './DemoSeeder.js'
import { ensureDefaultPages } from '../services/site.js'

export async function seed() {
  // Roles and permissions from app/permissions
  await seedPermissions()

  // About, Terms and Privacy pages (only the ones that don't exist yet)
  await ensureDefaultPages()

  // Example sale/land listings and an agent, for local development only:
  //   SEED_DEMO=true npx tylix db:seed
  if (process.env.SEED_DEMO === 'true') {
    await seedDemo()
  }
}
