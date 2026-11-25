// Public listing API: search, details, homepage sections and vacant units.
// Only published listings are ever returned.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { Listing } from "../models/Listing.js";
import { ListingUnit } from "../models/ListingUnit.js";
import { Agent } from "../models/Agent.js";
import { PropertyView } from "../models/PropertyView.js";
import { clientIp } from "../services/http.js";
import {
    CATEGORIES,
    categoriesInGroup,
    isCategory,
    presentCard,
    presentDetail,
    presentUnit,
    toNumber,
    type ListingRow,
    type UnitRow,
} from "../services/catalog.js";

const PAGE_SIZE = 12;
// Shown in search. let/sold stay reachable by link but leave the results.
const VISIBLE_STATUSES = ["available", "under_offer"];

const viewLimiter = createRateLimiter({ name: "listing-views", max: 60, windowMs: 60_000, store: "shared" });

export interface ListingFilters {
    purpose?: string;
    category?: string;
    group?: string;
    q?: string;
    min?: number;
    max?: number;
    beds?: number;
    featured?: boolean;
    vacant?: boolean;
}

function text(value: unknown, maxLength = 100): string {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// LIKE wildcards typed by a visitor are matched literally (dropped).
function likeTerm(value: string): string {
    return `%${value.toLowerCase().replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim()}%`;
}

export function readFilters(query: Record<string, unknown>): ListingFilters {
    const f: ListingFilters = {};
    const purpose = text(query.purpose);
    if (purpose === "rent" || purpose === "sale") f.purpose = purpose;
    const category = text(query.category);
    if (isCategory(category)) f.category = category;
    const group = text(query.group);
    if (["residential", "commercial", "land"].includes(group)) f.group = group;
    const q = text(query.q);
    if (q.length >= 2) f.q = q;
    const min = toNumber(query.min, NaN);
    if (min > 0) f.min = min;
    const max = toNumber(query.max, NaN);
    if (max > 0) f.max = max;
    const beds = toNumber(query.beds, NaN);
    if (beds >= 0 && beds <= 20 && query.beds !== undefined && query.beds !== "") f.beds = Math.floor(beds);
    if (query.featured === "1" || query.featured === "true") f.featured = true;
    if (query.vacant === "1" || query.vacant === "true") f.vacant = true;
    return f;
}

function filtered(f: ListingFilters) {
    let query = Listing.query().where("is_published", 1).whereIn("status", VISIBLE_STATUSES);
    if (f.purpose) query = query.where("purpose", f.purpose);
    if (f.category) query = query.where("category", f.category);
    else if (f.group) query = query.whereIn("category", categoriesInGroup(f.group));
    if (f.q) {
        // Every word must appear somewhere (title, location, type, description).
        for (const word of f.q.split(/\s+/).slice(0, 6)) {
            query = query.where("search_text", "LIKE", likeTerm(word));
        }
    }
    if (f.min) query = query.where("price", ">=", f.min);
    if (f.max) query = query.where("price", "<=", f.max);
    if (f.beds !== undefined) query = query.where("bedrooms", ">=", f.beds);
    if (f.featured) query = query.where("is_featured", 1);
    if (f.vacant) query = query.where("vacant_units", ">", 0);
    return query;
}

function sorted(query: ReturnType<typeof filtered>, sort: string) {
    if (sort === "price_asc") return query.orderBy("price", "ASC");
    if (sort === "price_desc") return query.orderBy("price", "DESC");
    return query.orderBy("published_at", "DESC").orderBy("id", "DESC");
}

async function publishedBySlug(slug: unknown): Promise<ListingRow | null> {
    const value = text(slug, 190);
    if (!value) return null;
    const row = (await Listing.query().where("slug", value).where("is_published", 1).first()) as ListingRow | null;
    return row;
}

async function agentCard(agentId: number | null) {
    if (!agentId) return null;
    const agent = (await Agent.find(agentId)) as Record<string, any> | null;
    if (!agent || !Number(agent.is_active)) return null;
    return {
        name: agent.name,
        title: agent.title ?? "",
        phone: agent.phone ?? "",
        whatsapp: agent.whatsapp ?? "",
        email: agent.email ?? "",
        photo: agent.photo ?? null,
    };
}

export class ListingController {
    async index(req: TylixRequest, res: TylixResponse) {
        const f = readFilters(req.query ?? {});
        const page = Math.max(1, Math.floor(toNumber(req.query?.page, 1)));
        const limit = Math.min(48, Math.max(1, Math.floor(toNumber(req.query?.limit, PAGE_SIZE))));
        const sort = text(req.query?.sort);

        const total = await filtered(f).count();
        const rows = (await sorted(filtered(f), sort).limit(limit).offset((page - 1) * limit).get()) as ListingRow[];

        return res.json({
            data: rows.map(presentCard),
            meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), filters: f },
        });
    }

    async home(_req: TylixRequest, res: TylixResponse) {
        let featured = (await filtered({ featured: true }).orderBy("published_at", "DESC").limit(6).get()) as ListingRow[];
        const recent = (await filtered({}).orderBy("published_at", "DESC").orderBy("id", "DESC").limit(8).get()) as ListingRow[];
        if (featured.length === 0) featured = recent.slice(0, 6);

        // One read for every count (the ORM's count() reads the rows anyway).
        const visible = (await filtered({}).get()) as ListingRow[];
        const counts: Record<string, number> = {};
        for (const c of CATEGORIES) counts[c.key] = visible.filter((l) => l.category === c.key).length;
        const purposeCounts = {
            rent: visible.filter((l) => l.purpose === "rent").length,
            sale: visible.filter((l) => l.purpose === "sale").length,
        };

        const vacant = await this.vacantList({ limit: 8 });

        return res.json({
            featured: featured.map(presentCard),
            recent: recent.map(presentCard),
            vacantUnits: vacant.items,
            vacantTotal: vacant.total,
            counts,
            purposeCounts,
        });
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const row = await publishedBySlug(req.params.slug);
        if (!row) {
            res.status(404);
            return res.json({ error: "That listing isn't available any more." });
        }

        const units = (await ListingUnit.where("property_id", row.id).where("is_listed", 1).orderBy("rent", "ASC").get()) as UnitRow[];
        const similar = (await filtered({ category: row.category, purpose: row.purpose })
            .where("id", "!=", row.id)
            .orderBy("published_at", "DESC")
            .limit(3)
            .get()) as ListingRow[];

        return res.json({
            data: {
                ...presentDetail(row, units),
                agent: await agentCard(row.agent_id),
            },
            similar: similar.map(presentCard),
        });
    }

    // Anonymous page views (signed-in views go through AccountController.recordView).
    async recordView(req: TylixRequest, res: TylixResponse) {
        if (!(await viewLimiter(`${clientIp(req)}`)).allowed) {
            res.status(204);
            return res.end();
        }
        const id = Math.floor(toNumber(req.params.id));
        const row = (await Listing.query().where("id", id).where("is_published", 1).first()) as ListingRow | null;
        if (row) await PropertyView.create({ property_id: row.id, user_id: null });
        res.status(204);
        return res.end();
    }

    async vacantUnits(req: TylixRequest, res: TylixResponse) {
        const page = Math.max(1, Math.floor(toNumber(req.query?.page, 1)));
        const result = await this.vacantList({
            category: isCategory(req.query?.category) ? String(req.query?.category) : undefined,
            q: text(req.query?.q),
            max: toNumber(req.query?.max, 0) || undefined,
            beds: req.query?.beds !== undefined && req.query?.beds !== "" ? Math.floor(toNumber(req.query?.beds, 0)) : undefined,
            page,
            limit: 24,
        });
        return res.json({
            data: result.items,
            meta: { page, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / 24)) },
        });
    }

    // Units that are vacant right now, on published listings.
    async vacantList(opts: { category?: string; q?: string; max?: number; beds?: number; page?: number; limit?: number }) {
        const listings = (await filtered({
            purpose: "rent",
            vacant: true,
            category: opts.category,
            q: opts.q && opts.q.length >= 2 ? opts.q : undefined,
        }).get()) as ListingRow[];
        if (listings.length === 0) return { items: [], total: 0 };

        const byId = new Map(listings.map((l) => [l.id, l]));
        let units = (await ListingUnit.query()
            .whereIn("property_id", listings.map((l) => l.id))
            .where("is_listed", 1)
            .orderBy("updated_at", "DESC")
            .get()) as UnitRow[];
        if (opts.max) units = units.filter((u) => toNumber(u.rent) <= Number(opts.max));
        if (opts.beds !== undefined) units = units.filter((u) => toNumber(u.bedrooms, -1) >= Number(opts.beds));

        const limit = opts.limit ?? 24;
        const start = ((opts.page ?? 1) - 1) * limit;
        const items = units.slice(start, start + limit).map((u) => {
            const listing = byId.get(u.property_id) as ListingRow;
            const card = presentCard(listing);
            const unit = presentUnit(u);
            // A short plain-text description: the cards show location, rent and
            // this, not the property's name.
            const summary = String(listing.description ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
            return { ...unit, cover: unit.cover ?? card.cover, summary, listing: card };
        });
        return { items, total: units.length };
    }
}
