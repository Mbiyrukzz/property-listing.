import type { Router } from '@tylix/core'
import { permissions } from '../permissions.js'
import { AdminController } from '../controllers/AdminController.js'
import { AdminLeadsController } from '../controllers/AdminLeadsController.js'

// The Barani Better Homes administration API, used by the pages in app/pages/admin.
// Registered from protectedRoutes() in web.ts (so every route needs a
// session), and each route also needs the permission named here. Roles and
// what they grant are in app/permissions.ts.
export function adminRoutes(router: Router) {
  const admin = new AdminController()
  const leads = new AdminLeadsController()
  const can = (name: string) => permissions.middleware(name)

  router.get('/api/admin/overview', can('admin.access'), (req, res) => admin.overview(req, res))

  router.get('/api/admin/listings', can('listings.view'), (req, res) => admin.listings(req, res))
  router.post('/api/admin/listings', can('listings.manage'), (req, res) => admin.createListing(req, res))
  router.get('/api/admin/listings/:id', can('listings.view'), (req, res) => admin.listing(req, res))
  // listings.feature covers featured/agent/features; the controller asks for
  // listings.manage before changing anything else.
  router.put('/api/admin/listings/:id', can('listings.feature'), (req, res) => admin.updateListing(req, res))
  router.delete('/api/admin/listings/:id', can('listings.manage'), (req, res) => admin.deleteListing(req, res))

  router.get('/api/admin/agents', can('admin.access'), (req, res) => admin.agents(req, res))
  router.post('/api/admin/agents', can('agents.manage'), (req, res) => admin.saveAgent(req, res))
  router.put('/api/admin/agents/:id', can('agents.manage'), (req, res) => admin.saveAgent(req, res))
  router.delete('/api/admin/agents/:id', can('agents.manage'), (req, res) => admin.deleteAgent(req, res))

  router.get('/api/admin/enquiries', can('enquiries.view'), (req, res) => leads.enquiries(req, res))
  router.put('/api/admin/enquiries/:id', can('enquiries.manage'), (req, res) => leads.updateEnquiry(req, res))
  router.get('/api/admin/viewings', can('viewings.manage'), (req, res) => leads.viewings(req, res))
  router.put('/api/admin/viewings/:id', can('viewings.manage'), (req, res) => leads.updateViewing(req, res))
  router.get('/api/admin/applications', can('applications.view'), (req, res) => leads.applications(req, res))
  router.put('/api/admin/applications/:id', can('applications.manage'), (req, res) => leads.updateApplication(req, res))
  router.get('/api/admin/customers', can('customers.view'), (req, res) => leads.customers(req, res))

  router.get('/api/admin/content', can('content.manage'), (req, res) => admin.content(req, res))
  router.put('/api/admin/settings', can('content.manage'), (req, res) => admin.saveSettings(req, res))
  router.put('/api/admin/pages/:slug', can('content.manage'), (req, res) => admin.savePage(req, res))
  router.delete('/api/admin/pages/:slug', can('content.manage'), (req, res) => admin.deletePage(req, res))

  router.get('/api/admin/reports', can('reports.view'), (req, res) => admin.reports(req, res))

  router.get('/api/admin/integration', can('integration.view'), (req, res) => admin.integration(req, res))
  router.post('/api/admin/integration/sync', can('integration.manage'), (req, res) => admin.syncNow(req, res))
}
