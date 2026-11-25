// Example Website-only listings (sales, land, commercial) and an agent, so a
// fresh development database has something on every page. Never run in
// production: these are not real properties. Rental listings come from
// Properman, not from here.
import { Agent } from '../models/Agent.js'
import { Listing } from '../models/Listing.js'
import { categoryLabel, searchText, slugify } from '../services/catalog.js'

const DEMO = [
  {
    title: '4-bedroom maisonette with garden, Nyali',
    purpose: 'sale', category: 'maisonette', location: 'Nyali, Mombasa', price: 28_500_000,
    bedrooms: 4, bathrooms: 4, size_sqm: 280,
    description: 'Spacious maisonette in a gated community of twelve homes. All bedrooms en suite, DSQ, borehole and solar water heating. Ten minutes to the beach.',
    features: ['Gated community', 'Borehole', 'DSQ', 'Solar water heating', 'Parking for 3'],
  },
  {
    title: '1/8 acre residential plot, Vipingo',
    purpose: 'sale', category: 'land', location: 'Vipingo, Kilifi', price: 1_650_000, land_size: '1/8 acre',
    description: 'Ready title deed, beacons in place. Power and water on the road. Fifteen minutes from Vipingo Ridge.',
    features: ['Title deed ready', 'Power on site', 'Water on site'],
  },
  {
    title: 'Ground-floor shop on Moi Avenue',
    purpose: 'rent', category: 'shop', location: 'Mombasa CBD', price: 65_000, size_sqm: 45,
    description: 'Street-facing shop with a glass front, high foot traffic and a back store. Three months deposit.',
    features: ['Street frontage', 'Back store', 'Water and power separately metered'],
  },
  {
    title: 'Open-plan office floor, Westlands',
    purpose: 'rent', category: 'office', location: 'Westlands, Nairobi', price: 180_000, size_sqm: 220,
    description: 'Fitted open-plan floor with two meeting rooms, backup generator, fibre and four parking bays.',
    features: ['Backup generator', 'Fibre internet', 'Lift', '4 parking bays'],
  },
]

export async function seed() {
  let agent = await Agent.query().where('email', 'agent@bbhomes.test').first() as { id: number } | null
  if (!agent) {
    agent = await Agent.create({
      name: 'Amina Wanjiru', title: 'Sales & lettings', email: 'agent@bbhomes.test',
      phone: '0712345678', whatsapp: '0712345678', is_active: 1,
      bio: 'Helps buyers and tenants on the coast and in Nairobi.',
    }) as { id: number }
  }

  for (const [i, item] of DEMO.entries()) {
    const slug = slugify(item.title)
    if (await Listing.query().where('slug', slug).first()) continue
    await Listing.create({
      source: 'manual',
      slug,
      title: item.title,
      purpose: item.purpose,
      category: item.category,
      location: item.location,
      description: item.description,
      price: item.price,
      bedrooms: item.bedrooms ?? null,
      bathrooms: item.bathrooms ?? null,
      size_sqm: item.size_sqm ?? null,
      land_size: item.land_size ?? null,
      features: JSON.stringify(item.features),
      images: '[]',
      status: 'available',
      is_published: 1,
      is_featured: i < 2 ? 1 : 0,
      agent_id: agent.id,
      published_at: new Date(Date.now() - i * 3_600_000).toISOString(),
      search_text: searchText([item.title, item.location, categoryLabel(item.category), item.description]),
    })
  }
}
