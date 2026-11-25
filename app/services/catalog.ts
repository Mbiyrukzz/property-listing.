// Listing vocabulary shared by the API, the sync and the admin, plus the
// helpers that turn database rows into what the pages receive.
//
// Imports nothing server-only, so pages may import the lists too.

export const PURPOSES = [
    { key: "rent", label: "For rent" },
    { key: "sale", label: "For sale" },
] as const;

export const CATEGORIES = [
    { key: "apartment", label: "Apartments", group: "residential" },
    { key: "house", label: "Houses", group: "residential" },
    { key: "maisonette", label: "Maisonettes", group: "residential" },
    { key: "furnished", label: "Furnished apartments", group: "residential" },
    { key: "commercial", label: "Commercial buildings", group: "commercial" },
    { key: "office", label: "Offices", group: "commercial" },
    { key: "shop", label: "Shops", group: "commercial" },
    { key: "land", label: "Land & plots", group: "land" },
] as const;

export const GROUPS = ["residential", "commercial", "land"] as const;

// available: can be let or bought. let/sold: kept for history, hidden from
// search. under_offer: still shown, marked as such.
export const STATUSES = ["available", "under_offer", "let", "sold"] as const;

export const ENQUIRY_STATUSES = ["new", "contacted", "closed"] as const;
export const VIEWING_STATUSES = ["requested", "confirmed", "completed", "cancelled"] as const;
export const APPLICATION_STATUSES = ["submitted", "reviewing", "approved", "rejected", "withdrawn"] as const;

const CATEGORY_KEYS: string[] = CATEGORIES.map((c) => c.key);

export function isCategory(value: unknown): boolean {
    return typeof value === "string" && CATEGORY_KEYS.includes(value);
}

export function categoryLabel(key: unknown): string {
    const found = CATEGORIES.find((c) => c.key === key);
    return found ? found.label : "Property";
}

export function categoriesInGroup(group: unknown): string[] {
    return CATEGORIES.filter((c) => c.group === group).map((c) => c.key);
}

export function slugify(text: unknown): string {
    return String(text ?? "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "listing";
}

export function parseJsonList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value !== "string" || value.trim() === "") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

export function toBool(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true";
}

// SQLite (node:sqlite) can't bind JavaScript booleans, so boolean columns
// are always written and queried as 1 or 0. MySQL's tinyint(1) is the same.
export function flag(value: unknown): 0 | 1 {
    return toBool(value) ? 1 : 0;
}

export function toNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Properman stores 0 bedrooms on many units and puts the real figure in the
// type ("2 Bedrooms"). Bedsitters and single rooms count as 0.
export function bedroomsFrom(bedrooms: unknown, typeLabel: unknown): number | null {
    const given = Number(bedrooms);
    if (Number.isFinite(given) && given > 0) return given;
    const label = String(typeLabel ?? "").toLowerCase();
    const match = /(\d+)\s*bed/.exec(label);
    if (match) return Number(match[1]);
    if (/bedsitter|single room|double room|studio/.test(label)) return 0;
    return null;
}

// Only http(s) URLs or files this app uploaded, never javascript: and the like.
export function safeImageUrl(value: unknown): string | null {
    const text = String(value ?? "").trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(text)) return text;
    if (/^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp|gif)$/.test(text)) return text;
    return null;
}

export interface ListingRow {
    id: number;
    source: string;
    external_id: number | null;
    slug: string;
    title: string;
    purpose: string;
    category: string;
    location: string | null;
    address: string | null;
    description: string | null;
    price: number | string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    size_sqm: number | string | null;
    land_size: string | null;
    features: string | null;
    cover_image: string | null;
    images: string | null;
    status: string;
    total_units: number | null;
    vacant_units: number | null;
    is_published: unknown;
    is_featured: unknown;
    agent_id: number | null;
    published_at: string | null;
    synced_at: string | null;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export interface UnitRow {
    id: number;
    property_id: number;
    external_id: number | null;
    slug: string | null;
    name: string;
    unit_type: string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    rent: number | string | null;
    is_vacant: unknown;
    is_listed: unknown;
    is_furnished: unknown;
    cover_image: string | null;
    images: string | null;
    [key: string]: unknown;
}

// What a listing card needs.
export function presentCard(row: ListingRow) {
    const images = parseJsonList(row.images);
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        purpose: row.purpose,
        category: row.category,
        categoryLabel: categoryLabel(row.category),
        location: row.location ?? "",
        price: toNumber(row.price),
        bedrooms: toNullableNumber(row.bedrooms),
        bathrooms: toNullableNumber(row.bathrooms),
        landSize: row.land_size ?? null,
        sizeSqm: toNullableNumber(row.size_sqm),
        cover: row.cover_image || images[0] || null,
        status: row.status,
        vacantUnits: toNumber(row.vacant_units),
        totalUnits: toNumber(row.total_units),
        isFeatured: toBool(row.is_featured),
        fromProperman: row.source === "properman",
        publishedAt: row.published_at ?? row.created_at,
    };
}

export function presentUnit(row: UnitRow) {
    const images = parseJsonList(row.images);
    return {
        id: row.id,
        name: row.name,
        type: row.unit_type ?? "",
        bedrooms: toNullableNumber(row.bedrooms),
        bathrooms: toNullableNumber(row.bathrooms),
        rent: toNumber(row.rent),
        isVacant: toBool(row.is_vacant),
        isFurnished: toBool(row.is_furnished),
        cover: row.cover_image || images[0] || null,
        images,
    };
}

// The whole listing for its own page.
export function presentDetail(row: ListingRow, units: UnitRow[]) {
    return {
        ...presentCard(row),
        address: row.address ?? "",
        description: row.description ?? "",
        features: parseJsonList(row.features),
        images: parseJsonList(row.images),
        units: units.map(presentUnit),
        syncedAt: row.synced_at,
    };
}

// The admin sees every column, parsed.
export function presentAdmin(row: ListingRow) {
    return {
        ...presentCard(row),
        source: row.source,
        externalId: row.external_id,
        address: row.address ?? "",
        description: row.description ?? "",
        features: parseJsonList(row.features),
        images: parseJsonList(row.images),
        isPublished: toBool(row.is_published),
        agentId: row.agent_id,
        syncedAt: row.synced_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function searchText(parts: unknown[]): string {
    return parts
        .map((p) => String(p ?? ""))
        .join(" ")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
}
