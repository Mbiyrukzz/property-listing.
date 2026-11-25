// Administration API: overview, listings, agents, content, reports and the
// Properman integration. Each route is guarded by a permission in
// app/routes/admin.ts; listing edits also check here which fields the
// caller may change.
//
// Properman listings: only the marketing fields (featured, agent, features)
// can be edited here. Everything else comes from Properman on every sync,
// so changing it here would be silently undone.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Listing } from "../models/Listing.js";
import { ListingUnit } from "../models/ListingUnit.js";
import { Agent } from "../models/Agent.js";
import { Enquiry } from "../models/Enquiry.js";
import { Viewing } from "../models/Viewing.js";
import { Application } from "../models/Application.js";
import { PropertyView } from "../models/PropertyView.js";
import { SavedProperty } from "../models/SavedProperty.js";
import { SyncLog } from "../models/SyncLog.js";
import { SitePage } from "../models/SitePage.js";
import { User } from "../models/User.js";
import { permissions } from "../permissions.js";
import { isConfigured, webhookSecret } from "../services/Properman.js";
import { syncAll } from "../services/ListingSync.js";
import { getSettings, saveSettings, SETTING_KEYS } from "../services/site.js";
import {
    CATEGORIES,
    categoryLabel,
    flag,
    presentAdmin,
    presentUnit,
    safeImageUrl,
    searchText,
    slugify,
    toNumber,
    type ListingRow,
    type UnitRow,
} from "../services/catalog.js";
import { validateAgent, validateListing, normaliseContact } from "../validators/ListingValidators.js";

type Row = Record<string, any>;

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function cleanImages(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list) {
        const url = safeImageUrl(item);
        if (url && !out.includes(url)) out.push(url);
    }
    return out.slice(0, 30);
}

function cleanFeatures(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((f) => String(f).trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
}

// Paths under /api/listings/ that are not listings.
const RESERVED_SLUGS = ["home", "vacant-units"];

async function uniqueSlug(base: string, ignoreId?: number): Promise<string> {
    if (RESERVED_SLUGS.includes(base)) base = `${base}-listing`;
    let slug = base;
    for (let i = 2; ; i++) {
        const taken = (await Listing.query().where("slug", slug).first()) as ListingRow | null;
        if (!taken || taken.id === ignoreId) return slug;
        slug = `${base}-${i}`;
    }
}

async function validAgentId(value: unknown): Promise<number | null> {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    return (await Agent.find(id)) ? id : null;
}

export class AdminController {
    // ── Overview ────────────────────────────────────────────────────────

    async overview(_req: TylixRequest, res: TylixResponse) {
        const listings = (await Listing.all()) as ListingRow[];
        const units = (await ListingUnit.query().where("is_listed", 1).get()) as UnitRow[];
        const newEnquiries = (await Enquiry.where("status", "new").latest().get()) as Row[];
        const openViewings = (await Viewing.query().whereIn("status", ["requested", "confirmed"]).orderBy("preferred_date", "ASC").get()) as Row[];
        const openApps = (await Application.query().whereIn("status", ["submitted", "reviewing"]).latest().get()) as Row[];
        const lastSync = (await SyncLog.query().where("event", "full").latest().first()) as Row | null;
        const lastError = (await SyncLog.query().where("status", "error").latest().first()) as Row | null;
        const views30 = await PropertyView.where("created_at", ">=", daysAgo(30)).count();

        const titles = new Map(listings.map((l) => [l.id, l.title]));
        const published = listings.filter((l) => Number(l.is_published) === 1);

        return res.json({
            stats: {
                published: published.length,
                forRent: published.filter((l) => l.purpose === "rent").length,
                forSale: published.filter((l) => l.purpose === "sale").length,
                featured: published.filter((l) => Number(l.is_featured) === 1).length,
                vacantUnits: units.length,
                newEnquiries: newEnquiries.length,
                openViewings: openViewings.length,
                openApplications: openApps.length,
                views30,
            },
            enquiries: newEnquiries.slice(0, 6).map((e) => ({
                id: e.id, name: e.name, phone: e.phone, kind: e.kind, createdAt: e.created_at,
                listing: e.property_id ? titles.get(Number(e.property_id)) ?? null : null,
            })),
            viewings: openViewings.slice(0, 6).map((v) => ({
                id: v.id, name: v.name, phone: v.phone, status: v.status, preferredDate: v.preferred_date,
                preferredTime: v.preferred_time, listing: titles.get(Number(v.property_id)) ?? null,
            })),
            integration: {
                configured: isConfigured(),
                lastSyncAt: lastSync?.created_at ?? null,
                lastSyncStatus: lastSync?.status ?? null,
                lastSyncMessage: lastSync?.message ?? null,
                lastErrorAt: lastError?.created_at ?? null,
            },
        });
    }

    // ── Listings ────────────────────────────────────────────────────────

    async listings(req: TylixRequest, res: TylixResponse) {
        let query = Listing.query();
        const source = String(req.query?.source ?? "");
        if (source === "properman" || source === "manual") query = query.where("source", source);
        const purpose = String(req.query?.purpose ?? "");
        if (purpose === "rent" || purpose === "sale") query = query.where("purpose", purpose);
        const published = String(req.query?.published ?? "");
        if (published === "1" || published === "0") query = query.where("is_published", Number(published));
        const q = String(req.query?.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, " ");
        if (q.length >= 2) query = query.where("search_text", "LIKE", `%${q}%`);

        const rows = (await query.orderBy("updated_at", "DESC").get()) as ListingRow[];
        return res.json({ data: rows.map(presentAdmin) });
    }

    async listing(req: TylixRequest, res: TylixResponse) {
        const row = (await Listing.find(Number(req.params.id))) as ListingRow | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Listing not found." });
        }
        const units = (await ListingUnit.where("property_id", row.id).orderBy("name", "ASC").get()) as UnitRow[];
        const [enquiries, viewings, applications, views, saves] = await Promise.all([
            Enquiry.where("property_id", row.id).count(),
            Viewing.where("property_id", row.id).count(),
            Application.where("property_id", row.id).count(),
            PropertyView.where("property_id", row.id).count(),
            SavedProperty.where("property_id", row.id).count(),
        ]);
        return res.json({
            data: { ...presentAdmin(row), units: units.map((u) => ({ ...presentUnit(u), isListed: Number(u.is_listed) === 1 })) },
            activity: { enquiries, viewings, applications, views, saves },
        });
    }

    async createListing(req: TylixRequest, res: TylixResponse) {
        const body = (req.body ?? {}) as Row;
        const result = validateListing(body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const images = cleanImages(body.images);
        const isPublished = flag(body.is_published);
        const values = {
            source: "manual",
            external_id: null,
            title: String(body.title).trim(),
            purpose: body.purpose,
            category: body.category,
            location: String(body.location).trim(),
            address: String(body.address ?? "").trim() || null,
            description: String(body.description).trim(),
            price: toNumber(body.price),
            bedrooms: body.bedrooms === "" || body.bedrooms === null || body.bedrooms === undefined ? null : Number(body.bedrooms),
            bathrooms: body.bathrooms === "" || body.bathrooms === null || body.bathrooms === undefined ? null : Number(body.bathrooms),
            size_sqm: body.size_sqm === "" || body.size_sqm === null || body.size_sqm === undefined ? null : Number(body.size_sqm),
            land_size: String(body.land_size ?? "").trim() || null,
            features: JSON.stringify(cleanFeatures(body.features)),
            cover_image: images[0] ?? null,
            images: JSON.stringify(images),
            status: body.status ?? "available",
            total_units: 0,
            vacant_units: 0,
            is_published: isPublished,
            is_featured: flag(body.is_featured),
            agent_id: await validAgentId(body.agent_id),
            published_at: isPublished ? new Date().toISOString() : null,
        };
        const row = (await Listing.create({
            ...values,
            slug: await uniqueSlug(slugify(values.title)),
            search_text: searchText([values.title, values.location, values.address, categoryLabel(values.category), values.description]),
        })) as ListingRow;

        res.status(201);
        return res.json({ data: presentAdmin(row) });
    }

    async updateListing(req: TylixRequest, res: TylixResponse) {
        const row = (await Listing.find(Number(req.params.id))) as ListingRow | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Listing not found." });
        }
        const body = (req.body ?? {}) as Row;

        // Marketing fields: listings.feature is enough.
        const marketing: Row = {};
        if ("is_featured" in body) marketing.is_featured = flag(body.is_featured);
        if ("agent_id" in body) marketing.agent_id = await validAgentId(body.agent_id);
        if ("features" in body) marketing.features = JSON.stringify(cleanFeatures(body.features));

        const otherFields = Object.keys(body).filter((k) => !["is_featured", "agent_id", "features"].includes(k));
        if (otherFields.length > 0) {
            if (row.source === "properman") {
                res.status(422);
                return res.json({
                    error: "This listing comes from HQ. Edit its details, photos and units in HQ; only featured, agent and features can be changed here.",
                });
            }
            if (!(await permissions.can(req.user as any, "listings.manage"))) {
                res.status(403);
                return res.json({ error: "You can only change featured, agent and features." });
            }

            const merged = { ...presentAdminInput(row), ...body };
            const result = validateListing(merged);
            if (!result.valid) {
                res.status(422);
                return res.json({ errors: result.errors });
            }
            const images = "images" in body ? cleanImages(body.images) : null;
            const wasPublished = Number(row.is_published) === 1;
            const isPublished = "is_published" in body ? flag(body.is_published) : (wasPublished ? 1 : 0);
            const title = String(merged.title).trim();
            const updates: Row = {
                title,
                purpose: merged.purpose,
                category: merged.category,
                location: String(merged.location).trim(),
                address: String(merged.address ?? "").trim() || null,
                description: String(merged.description).trim(),
                price: toNumber(merged.price),
                bedrooms: merged.bedrooms === "" || merged.bedrooms === null || merged.bedrooms === undefined ? null : Number(merged.bedrooms),
                bathrooms: merged.bathrooms === "" || merged.bathrooms === null || merged.bathrooms === undefined ? null : Number(merged.bathrooms),
                size_sqm: merged.size_sqm === "" || merged.size_sqm === null || merged.size_sqm === undefined ? null : Number(merged.size_sqm),
                land_size: String(merged.land_size ?? "").trim() || null,
                status: merged.status ?? row.status,
                is_published: isPublished,
                published_at: isPublished && !wasPublished ? new Date().toISOString() : row.published_at,
                search_text: searchText([title, merged.location, merged.address, categoryLabel(merged.category), merged.description]),
            };
            if (images) {
                updates.images = JSON.stringify(images);
                updates.cover_image = images[0] ?? null;
            }
            if (title !== row.title) updates.slug = await uniqueSlug(slugify(title), row.id);
            Object.assign(marketing, updates);
        }

        if (Object.keys(marketing).length === 0) {
            return res.json({ data: presentAdmin(row) });
        }
        await Listing.update(row.id, marketing);
        return res.json({ data: presentAdmin((await Listing.find(row.id)) as ListingRow) });
    }

    async deleteListing(req: TylixRequest, res: TylixResponse) {
        const row = (await Listing.find(Number(req.params.id))) as ListingRow | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Listing not found." });
        }
        if (row.source === "properman") {
            res.status(422);
            return res.json({ error: "Unpublish it in HQ instead; it leaves the site on the next sync." });
        }
        const linked =
            (await Enquiry.where("property_id", row.id).count()) +
            (await Viewing.where("property_id", row.id).count()) +
            (await Application.where("property_id", row.id).count());
        if (linked > 0) {
            res.status(409);
            return res.json({ error: "Customers have enquired or applied for this listing. Unpublish it instead so their history stays." });
        }
        for (const s of (await SavedProperty.where("property_id", row.id).get()) as Row[]) await SavedProperty.delete(s.id);
        await Listing.delete(row.id);
        res.status(204);
        return res.end();
    }

    // ── Agents ──────────────────────────────────────────────────────────

    async agents(_req: TylixRequest, res: TylixResponse) {
        const rows = (await Agent.query().orderBy("name", "ASC").get()) as Row[];
        const listings = (await Listing.all()) as ListingRow[];
        return res.json({
            data: rows.map((a) => ({
                id: a.id, name: a.name, title: a.title ?? "", email: a.email ?? "", phone: a.phone ?? "",
                whatsapp: a.whatsapp ?? "", photo: a.photo ?? null, bio: a.bio ?? "", isActive: Number(a.is_active) === 1,
                listings: listings.filter((l) => Number(l.agent_id) === a.id).length,
            })),
        });
    }

    async saveAgent(req: TylixRequest, res: TylixResponse) {
        const body = normaliseContact((req.body ?? {}) as Row) as Row;
        const result = validateAgent(body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }
        const values = {
            name: String(body.name).trim(),
            title: String(body.title ?? "").trim() || null,
            email: String(body.email ?? "").trim() || null,
            phone: String(body.phone ?? "") || null,
            whatsapp: String(body.whatsapp ?? "").replace(/[\s-]/g, "") || null,
            photo: safeImageUrl(body.photo),
            bio: String(body.bio ?? "").trim() || null,
            is_active: "isActive" in body ? flag(body.isActive) : 1,
        };
        if (req.params.id) {
            const id = Number(req.params.id);
            if (!(await Agent.find(id))) {
                res.status(404);
                return res.json({ error: "Agent not found." });
            }
            await Agent.update(id, values);
            return res.json({ data: { id } });
        }
        const created = (await Agent.create(values)) as Row;
        res.status(201);
        return res.json({ data: { id: created.id } });
    }

    async deleteAgent(req: TylixRequest, res: TylixResponse) {
        const id = Number(req.params.id);
        const listings = (await Listing.where("agent_id", id).get()) as ListingRow[];
        for (const l of listings) await Listing.update(l.id, { agent_id: null });
        await Agent.delete(id);
        res.status(204);
        return res.end();
    }

    // ── Content ─────────────────────────────────────────────────────────

    async content(_req: TylixRequest, res: TylixResponse) {
        const pages = (await SitePage.query().orderBy("title", "ASC").get()) as Row[];
        return res.json({
            settings: await getSettings(),
            keys: SETTING_KEYS,
            pages: pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title, body: p.body ?? "", isPublished: Number(p.is_published) === 1, updatedAt: p.updated_at })),
        });
    }

    async saveSettings(req: TylixRequest, res: TylixResponse) {
        const body = (req.body ?? {}) as Row;
        if (body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email))) {
            res.status(422);
            return res.json({ errors: { email: ["Enter a valid email address."] } });
        }
        return res.json({ settings: await saveSettings(body) });
    }

    async savePage(req: TylixRequest, res: TylixResponse) {
        const body = (req.body ?? {}) as Row;
        const slug = slugify(req.params.slug);
        const title = String(body.title ?? "").trim();
        if (!title) {
            res.status(422);
            return res.json({ errors: { title: ["Give the page a title."] } });
        }
        const values = { slug, title: title.slice(0, 200), body: String(body.body ?? "").slice(0, 50_000), is_published: flag(body.isPublished ?? true) };
        await SitePage.updateOrCreate({ slug }, values);
        return res.json({ data: { slug } });
    }

    async deletePage(req: TylixRequest, res: TylixResponse) {
        const row = (await SitePage.query().where("slug", String(req.params.slug)).first()) as Row | null;
        if (row) await SitePage.delete(row.id);
        res.status(204);
        return res.end();
    }

    // ── Reports ─────────────────────────────────────────────────────────

    async reports(req: TylixRequest, res: TylixResponse) {
        const days = [7, 30, 90, 365].includes(Number(req.query?.days)) ? Number(req.query?.days) : 30;
        const since = daysAgo(days);

        const [listings, enquiries, viewings, applications, views, users] = (await Promise.all([
            Listing.all(),
            Enquiry.where("created_at", ">=", since).get(),
            Viewing.where("created_at", ">=", since).get(),
            Application.where("created_at", ">=", since).get(),
            PropertyView.where("created_at", ">=", since).get(),
            User.query().where("created_at", ">=", since).get(),
        ])) as Row[][];

        const byKey = (rows: Row[], key: string) => {
            const out: Record<string, number> = {};
            for (const r of rows) out[String(r[key] ?? "none")] = (out[String(r[key] ?? "none")] ?? 0) + 1;
            return out;
        };
        const perDay = (rows: Row[]) => {
            const out: Record<string, number> = {};
            for (let i = days - 1; i >= 0; i--) out[daysAgo(i)] = 0;
            for (const r of rows) {
                const d = String(r.created_at).slice(0, 10);
                if (d in out) out[d]++;
            }
            return Object.entries(out).map(([date, count]) => ({ date, count }));
        };

        const titles = new Map(listings.map((l) => [l.id, l.title]));
        const viewCounts = byKey(views, "property_id");
        const enquiryCounts = byKey(enquiries, "property_id");
        const topListings = Object.entries(viewCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([id, count]) => ({ id: Number(id), title: titles.get(Number(id)) ?? `#${id}`, views: count, enquiries: enquiryCounts[id] ?? 0 }));

        const published = listings.filter((l) => Number(l.is_published) === 1);
        return res.json({
            days,
            totals: {
                enquiries: enquiries.length,
                viewings: viewings.length,
                applications: applications.length,
                views: views.length,
                newCustomers: users.length,
                approved: applications.filter((a) => a.status === "approved").length,
            },
            enquiriesByKind: byKey(enquiries, "kind"),
            viewingsByStatus: byKey(viewings, "status"),
            applicationsByStatus: byKey(applications, "status"),
            enquiriesPerDay: perDay(enquiries),
            viewsPerDay: perDay(views),
            topListings,
            inventory: CATEGORIES.map((c) => ({
                key: c.key,
                label: c.label,
                rent: published.filter((l) => l.category === c.key && l.purpose === "rent").length,
                sale: published.filter((l) => l.category === c.key && l.purpose === "sale").length,
            })),
        });
    }

    // ── Properman integration ───────────────────────────────────────────

    async integration(_req: TylixRequest, res: TylixResponse) {
        const logs = (await SyncLog.query().latest().limit(60).get()) as Row[];
        const fromProperman = (await Listing.where("source", "properman").get()) as ListingRow[];
        const lastFull = (await SyncLog.query().where("event", "full").latest().first()) as Row | null;
        const lastWebhook = (await SyncLog.query().where("trigger", "webhook").latest().first()) as Row | null;
        let host = "";
        try {
            host = process.env.HQ_URL ? new URL(process.env.HQ_URL).host : "";
        } catch {
            host = "invalid HQ_URL";
        }
        return res.json({
            configured: isConfigured(),
            webhookConfigured: webhookSecret() !== "",
            host,
            intervalMinutes: Math.max(1, Number(process.env.HQ_SYNC_MINUTES ?? 10) || 10),
            listings: {
                total: fromProperman.length,
                published: fromProperman.filter((l) => Number(l.is_published) === 1).length,
                vacantUnits: fromProperman.reduce((n, l) => n + (Number(l.is_published) === 1 ? toNumber(l.vacant_units) : 0), 0),
            },
            lastFull: lastFull ? { at: lastFull.created_at, status: lastFull.status, message: lastFull.message } : null,
            lastWebhook: lastWebhook ? { at: lastWebhook.created_at, status: lastWebhook.status, message: lastWebhook.message } : null,
            logs: logs.map((l) => ({
                id: l.id, trigger: l.trigger, event: l.event, externalId: l.external_id, status: l.status,
                message: l.message, upserted: l.upserted, removed: l.removed, durationMs: l.duration_ms, at: l.created_at,
            })),
        });
    }

    async syncNow(_req: TylixRequest, res: TylixResponse) {
        const outcome = await syncAll("manual");
        res.status(outcome.status === "error" ? 502 : 200);
        return res.json({ outcome });
    }
}

// The stored listing in the shape validateListing() reads.
function presentAdminInput(row: ListingRow): Row {
    return {
        title: row.title,
        purpose: row.purpose,
        category: row.category,
        location: row.location ?? "",
        address: row.address ?? "",
        description: row.description ?? "",
        price: toNumber(row.price),
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        size_sqm: row.size_sqm === null ? null : toNumber(row.size_sqm),
        land_size: row.land_size ?? "",
        status: row.status,
    };
}
