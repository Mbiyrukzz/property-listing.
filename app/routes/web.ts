import type { Router } from '@tylix/core'
import { PostController } from '../controllers/PostController.js'
import { UploadController } from '../controllers/UploadController.js'
import { ListingController } from '../controllers/ListingController.js'
import { EnquiryController } from '../controllers/EnquiryController.js'
import { SiteController } from '../controllers/SiteController.js'
import { WebhookController } from '../controllers/WebhookController.js'
import { AccountController } from '../controllers/AccountController.js'
import { TenantController } from '../controllers/TenantController.js'
import { permissions } from '../permissions.js'
import { accessRoutes } from './access.js'
import { adminRoutes } from './admin.js'

// Public routes: no login needed.
export async function publicRoutes(router: Router) {
  const posts = new PostController()
  const listings = new ListingController()
  const enquiries = new EnquiryController()
  const site = new SiteController()
  const webhooks = new WebhookController()

  // News & insights (the starter's posts)
  router.get('/api/public/posts', (req, res) => posts.publicIndex(req, res))
  router.get('/api/public/posts/:id', (req, res) => posts.publicShow(req, res))

  // Listings
  router.get('/api/listings', (req, res) => listings.index(req, res))
  router.get('/api/listings/home', (req, res) => listings.home(req, res))
  router.get('/api/listings/vacant-units', (req, res) => listings.vacantUnits(req, res))
  router.get('/api/listings/:slug', (req, res) => listings.show(req, res))
  router.post('/api/listings/:id/view', (req, res) => listings.recordView(req, res))

  // Guest enquiries and viewing requests (signed-in ones use /api/account/...)
  router.post('/api/enquiries', (req, res) => enquiries.storeEnquiry(req, res))
  router.post('/api/viewings', (req, res) => enquiries.storeViewing(req, res))

  // Site content
  router.get('/api/site', (req, res) => site.site(req, res))
  router.get('/api/pages/:slug', (req, res) => site.page(req, res))
  router.get('/api/agents', (req, res) => site.agents(req, res))

  // Properman → Barani Better Homes (signed; see app/controllers/WebhookController)
  router.post('/api/integrations/hq/webhook', (req, res) => webhooks.properman(req, res))
}

// Protected routes: every route here requires a logged-in user.
export async function protectedRoutes(router: Router) {
  // Roles and permissions admin API (app/routes/access)
  accessRoutes(router)
  // Barani Better Homes administration API (app/routes/admin)
  adminRoutes(router)

  const uploads = new UploadController()
  const posts = new PostController()
  const account = new AccountController()
  const enquiries = new EnquiryController()
  const tenant = new TenantController()

  router.post('/api/uploads', (req, res) => uploads.store(req, res))

  // Writing news is for staff. Registered before the generated Post feature
  // routes, so this one answers POST /api/posts (the first match wins).
  router.post('/api/posts', permissions.middleware('posts.create'), (req, res) => posts.store(req, res))

  // Customer account
  router.get('/api/account/overview', (req, res) => account.overview(req, res))
  router.get('/api/account/profile', (req, res) => account.profile(req, res))
  router.put('/api/account/profile', (req, res) => account.updateProfile(req, res))
  router.get('/api/account/saved', (req, res) => account.saved(req, res))
  router.get('/api/account/saved/ids', (req, res) => account.savedIds(req, res))
  router.post('/api/account/saved', (req, res) => account.save(req, res))
  router.delete('/api/account/saved/:propertyId', (req, res) => account.unsave(req, res))
  router.get('/api/account/history', (req, res) => account.history(req, res))
  router.post('/api/account/history', (req, res) => account.recordView(req, res))
  router.delete('/api/account/history', (req, res) => account.clearHistory(req, res))
  router.get('/api/account/activity', (req, res) => account.activity(req, res))
  router.post('/api/account/enquiries', (req, res) => enquiries.storeEnquiry(req, res))
  router.post('/api/account/viewings', (req, res) => enquiries.storeViewing(req, res))
  router.put('/api/account/viewings/:id/cancel', (req, res) => account.cancelViewing(req, res))
  router.post('/api/account/applications', (req, res) => account.apply(req, res))
  router.put('/api/account/applications/:id/withdraw', (req, res) => account.withdraw(req, res))

  // Tenant portal (Properman tenancy)
  router.get('/api/tenant', (req, res) => tenant.status(req, res))
  router.post('/api/tenant/link', (req, res) => tenant.startLink(req, res))
  router.post('/api/tenant/link/confirm', (req, res) => tenant.confirmLink(req, res))
  router.delete('/api/tenant/link', (req, res) => tenant.unlink(req, res))
  router.get('/api/tenant/invoices', (req, res) => tenant.invoices(req, res))
  router.get('/api/tenant/payments', (req, res) => tenant.payments(req, res))
  router.post('/api/tenant/pay', (req, res) => tenant.pay(req, res))
  router.get('/api/tenant/pay/:id', (req, res) => tenant.paymentStatus(req, res))
}
