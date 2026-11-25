// Keeps Barani Better Homes' copy of Properman listings current.
//
// Properman owns the property records, units and vacancies; this only mirrors
// what Properman publishes. Two ways in, both ending in the same upsert:
//
//   syncOne(id)  after a webhook (app/jobs/SyncPropermanProperty)
//   syncAll()    on a schedule (app/schedule.ts) and from the admin, as the
//                safety net for missed webhooks; anything Properman no
//                longer lists is taken off the site.
//
// Rows are never deleted: enquiries and applications point at them. A
// listing Properman stops publishing is marked unpublished instead.
//
// Barani Better Homes-owned marketing fields (is_featured, agent_id, features) are never
// written here, so admin edits to them survive every sync.

import { Listing } from "../models/Listing.js";
import { ListingUnit } from "../models/ListingUnit.js";
import { SyncLog } from "../models/SyncLog.js";
import { Properman, PropermanError, absoluteMediaUrl, isConfigured, type PropermanProperty, type PropermanUnit } from "./Properman.js";
import {
    bedroomsFrom,
    categoryLabel,
    flag,
    isCategory,
    safeImageUrl,
    searchText,
    slugify,
    type ListingRow,
    type UnitRow,
} from "./catalog.js";

export interface SyncOutcome {
    status: "ok" | "error" | "skipped";
    upserted: number;
    removed: number;
    message: string;
}

const now = () => new Date().toISOString();

async function log(trigger: string, event: string, externalId: number | null, outcome: SyncOutcome, startedAt: number) {
    try {
        await SyncLog.create({
            trigger,
            event,
            external_id: externalId,
            status: outcome.status,
            message: outcome.message.slice(0, 2000),
            upserted: outcome.upserted,
            removed: outcome.removed,
            duration_ms: Date.now() - startedAt,
        });
    } catch (err) {
        console.error("[sync] could not write sync log:", err);
    }
}

function images(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list) {
        const url = safeImageUrl(absoluteMediaUrl(item));
        if (url && !out.includes(url)) out.push(url);
    }
    return out.slice(0, 40);
}

async function upsertUnits(listingId: number, units: PropermanUnit[], furnished: boolean) {
    const seen: number[] = [];

    for (const unit of units) {
        const externalId = Number(unit.id);
        if (!Number.isInteger(externalId)) continue;
        seen.push(externalId);

        const unitImages = images(unit.images);
        const values = {
            property_id: listingId,
            external_id: externalId,
            slug: unit.slug ?? null,
            name: String(unit.name ?? `Unit ${externalId}`).slice(0, 190),
            unit_type: String(unit.type ?? "").slice(0, 60),
            bedrooms: bedroomsFrom(unit.bedrooms, unit.type),
            bathrooms: Number(unit.bathrooms) || null,
            rent: Number(unit.rent) || 0,
            is_vacant: flag(unit.vacant === true),
            is_listed: flag(unit.vacant === true),
            is_furnished: flag(furnished),
            cover_image: unitImages[0] ?? null,
            images: JSON.stringify(unitImages),
            synced_at: now(),
        };

        const existing = (await ListingUnit.query().where("external_id", externalId).first()) as UnitRow | null;
        if (existing) {
            await ListingUnit.update(existing.id, values);
        } else {
            await ListingUnit.create(values);
        }
    }

    // Units Properman no longer sends (hidden, deleted or moved): off the site.
    const local = (await ListingUnit.where("property_id", listingId).get()) as UnitRow[];
    for (const unit of local) {
        if (unit.external_id !== null && !seen.includes(Number(unit.external_id))) {
            await ListingUnit.update(unit.id, { is_listed: 0, is_vacant: 0, synced_at: now() });
        }
    }
}

async function uniqueSlug(base: string): Promise<string> {
    let slug = base;
    for (let i = 2; await Listing.query().where("slug", slug).first(); i++) {
        slug = `${base}-${i}`;
    }
    return slug;
}

// Writes one Properman property (and its units) into the local tables.
export async function upsertProperty(item: PropermanProperty): Promise<number> {
    const externalId = Number(item.id);
    if (!Number.isInteger(externalId)) throw new Error("HQ sent a property without an id.");

    const units = Array.isArray(item.units) ? item.units : [];
    const vacant = units.filter((u) => u.vacant === true);
    const rents = (vacant.length > 0 ? vacant : units).map((u) => Number(u.rent) || 0).filter((r) => r > 0);
    const bedrooms = (vacant.length > 0 ? vacant : units)
        .map((u) => bedroomsFrom(u.bedrooms, u.type))
        .filter((b): b is number => b !== null);
    const bathrooms = (vacant.length > 0 ? vacant : units).map((u) => Number(u.bathrooms) || 0);

    const category = isCategory(item.category) ? item.category : "apartment";
    let gallery = images(item.images);
    if (gallery.length === 0) {
        gallery = images(units.flatMap((u) => (Array.isArray(u.images) ? u.images : [])));
    }

    const values = {
        source: "properman",
        external_id: externalId,
        title: String(item.name ?? "").slice(0, 200) || `Property ${externalId}`,
        purpose: "rent",
        category,
        location: String(item.location ?? "").slice(0, 190),
        description: String(item.description ?? ""),
        price: rents.length > 0 ? Math.min(...rents) : 0,
        bedrooms: bedrooms.length > 0 ? Math.max(...bedrooms) : null,
        bathrooms: bathrooms.length > 0 ? Math.max(...bathrooms) || null : null,
        cover_image: gallery[0] ?? null,
        images: JSON.stringify(gallery),
        status: vacant.length > 0 ? "available" : "let",
        total_units: units.length,
        vacant_units: vacant.length,
        is_published: 1,
        published_at: item.published_at ?? now(),
        search_text: searchText([
            item.name,
            item.location,
            categoryLabel(category),
            item.description,
            ...units.map((u) => u.type),
        ]),
        synced_at: now(),
    };

    let row = (await Listing.query()
        .where("source", "properman")
        .where("external_id", externalId)
        .first()) as ListingRow | null;

    if (row) {
        await Listing.update(row.id, values);
    } else {
        const slug = await uniqueSlug(`${slugify(item.name)}-${externalId}`);
        try {
            row = (await Listing.create({ ...values, slug })) as ListingRow;
        } catch (err) {
            // Another sync created it a moment ago (unique source+external_id).
            row = (await Listing.query()
                .where("source", "properman")
                .where("external_id", externalId)
                .first()) as ListingRow | null;
            if (!row) throw err;
            await Listing.update(row.id, values);
        }
    }

    await upsertUnits(row.id, units, category === "furnished");
    return row.id;
}

// Takes a Properman listing off the site (unpublished or deleted there).
export async function unpublishProperty(externalId: number): Promise<boolean> {
    const row = (await Listing.query()
        .where("source", "properman")
        .where("external_id", externalId)
        .first()) as ListingRow | null;
    if (!row) return false;

    await Listing.update(row.id, { is_published: 0, vacant_units: 0, synced_at: now() });
    const units = (await ListingUnit.where("property_id", row.id).get()) as UnitRow[];
    for (const unit of units) {
        await ListingUnit.update(unit.id, { is_listed: 0, synced_at: now() });
    }
    return true;
}

export async function syncOne(externalId: number, trigger = "webhook", event = "property.updated"): Promise<SyncOutcome> {
    const startedAt = Date.now();
    let outcome: SyncOutcome;

    if (!isConfigured()) {
        outcome = { status: "skipped", upserted: 0, removed: 0, message: "HQ is not configured." };
        await log(trigger, event, externalId, outcome, startedAt);
        return outcome;
    }

    try {
        const res = await Properman.getProperty(externalId);
        if (res.status === 404) {
            const removed = await unpublishProperty(externalId);
            outcome = { status: "ok", upserted: 0, removed: removed ? 1 : 0, message: "Not published in HQ: removed from the site." };
        } else if (!res.ok || !res.data?.data) {
            outcome = { status: "error", upserted: 0, removed: 0, message: `HQ answered ${res.status}.` };
        } else {
            await upsertProperty(res.data.data);
            outcome = { status: "ok", upserted: 1, removed: 0, message: `Updated "${res.data.data.name}".` };
        }
    } catch (err) {
        outcome = { status: "error", upserted: 0, removed: 0, message: err instanceof Error ? err.message : String(err) };
    }

    await log(trigger, event, externalId, outcome, startedAt);
    if (outcome.status === "error" && trigger === "webhook") {
        // Let the queue retry it.
        throw new Error(outcome.message);
    }
    return outcome;
}

export async function syncAll(trigger = "schedule"): Promise<SyncOutcome> {
    const startedAt = Date.now();
    let outcome: SyncOutcome;

    if (!isConfigured()) {
        outcome = { status: "skipped", upserted: 0, removed: 0, message: "HQ is not configured." };
        await log(trigger, "full", null, outcome, startedAt);
        return outcome;
    }

    try {
        const res = await Properman.listProperties();
        if (!res.ok || !Array.isArray(res.data?.data)) {
            throw new PropermanError(`Properman answered ${res.status}.`, res.status);
        }

        const items = res.data.data;
        const seen = new Set<number>();
        const failures: string[] = [];
        let upserted = 0;

        for (const item of items) {
            try {
                await upsertProperty(item);
                seen.add(Number(item.id));
                upserted++;
            } catch (err) {
                seen.add(Number(item.id)); // a bad record must not unpublish itself
                failures.push(`#${item.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Anything published here that Properman no longer lists.
        let removed = 0;
        const published = (await Listing.query()
            .where("source", "properman")
            .where("is_published", 1)
            .get()) as ListingRow[];
        for (const row of published) {
            if (row.external_id !== null && !seen.has(Number(row.external_id))) {
                await unpublishProperty(Number(row.external_id));
                removed++;
            }
        }

        outcome = {
            status: failures.length > 0 ? "error" : "ok",
            upserted,
            removed,
            message:
                failures.length > 0
                    ? `${upserted} updated, ${failures.length} failed: ${failures.join("; ")}`
                    : `${upserted} listing(s) up to date, ${removed} removed.`,
        };
    } catch (err) {
        // Properman unreachable: change nothing, so the site keeps its last good copy.
        outcome = { status: "error", upserted: 0, removed: 0, message: err instanceof Error ? err.message : String(err) };
    }

    await log(trigger, "full", null, outcome, startedAt);
    return outcome;
}
