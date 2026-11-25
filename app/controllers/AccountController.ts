// The signed-in customer's own data: profile, saved properties, enquiries,
// viewings, applications and viewing history. Every query is scoped to
// req.user.userId; nothing here can read another customer's rows.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { User } from "../models/User.js";
import { CustomerProfile } from "../models/CustomerProfile.js";
import { SavedProperty } from "../models/SavedProperty.js";
import { PropertyView } from "../models/PropertyView.js";
import { Enquiry } from "../models/Enquiry.js";
import { Viewing } from "../models/Viewing.js";
import { Application } from "../models/Application.js";
import { Listing } from "../models/Listing.js";
import { ListingUnit } from "../models/ListingUnit.js";
import { normaliseContact, validateApplication, PHONE_RE } from "../validators/ListingValidators.js";
import { presentCard, toNumber, type ListingRow, type UnitRow } from "../services/catalog.js";

type Row = Record<string, any>;

function uid(req: TylixRequest): number {
    return Number(req.user?.userId);
}

async function listingsById(ids: number[]): Promise<Map<number, ListingRow>> {
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return new Map();
    const rows = (await Listing.query().whereIn("id", unique).get()) as ListingRow[];
    return new Map(rows.map((r) => [r.id, r]));
}

async function unitNames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return new Map();
    const rows = (await ListingUnit.query().whereIn("id", unique).get()) as UnitRow[];
    return new Map(rows.map((r) => [r.id, r.name]));
}

function listingRef(map: Map<number, ListingRow>, id: number | null) {
    const row = id ? map.get(id) : undefined;
    return row ? { id: row.id, slug: row.slug, title: row.title, location: row.location ?? "", isPublished: Boolean(Number(row.is_published)) } : null;
}

async function profileOf(userId: number) {
    const user = (await User.find(userId)) as Row | null;
    const profile = (await CustomerProfile.query().where("user_id", userId).first()) as Row | null;
    return {
        name: user?.name ?? "",
        email: user?.email ?? "",
        emailVerified: Boolean(user?.email_verified_at),
        phone: profile?.phone ?? "",
        preferredContact: profile?.preferred_contact ?? "phone",
        lookingFor: profile?.looking_for ?? "",
        preferredLocation: profile?.preferred_location ?? "",
        budgetMax: profile?.budget_max === null || profile?.budget_max === undefined ? null : toNumber(profile.budget_max),
    };
}

export class AccountController {
    async overview(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const [saved, enquiries, viewings, applications] = await Promise.all([
            SavedProperty.where("user_id", userId).get(),
            Enquiry.where("user_id", userId).latest().get(),
            Viewing.where("user_id", userId).latest().get(),
            Application.where("user_id", userId).latest().get(),
        ]);
        const all = [...(enquiries as Row[]), ...(viewings as Row[]), ...(applications as Row[])];
        const map = await listingsById(all.map((r) => Number(r.property_id)));

        const recent = [
            ...(enquiries as Row[]).map((r) => ({ type: "enquiry", status: r.status, at: r.created_at, listing: listingRef(map, r.property_id) })),
            ...(viewings as Row[]).map((r) => ({ type: "viewing", status: r.status, at: r.created_at, listing: listingRef(map, r.property_id) })),
            ...(applications as Row[]).map((r) => ({ type: "application", status: r.status, at: r.created_at, listing: listingRef(map, r.property_id) })),
        ]
            .sort((a, b) => String(b.at).localeCompare(String(a.at)))
            .slice(0, 6);

        return res.json({
            profile: await profileOf(userId),
            counts: {
                saved: (saved as Row[]).length,
                enquiries: (enquiries as Row[]).length,
                viewings: (viewings as Row[]).filter((v) => v.status === "requested" || v.status === "confirmed").length,
                applications: (applications as Row[]).filter((a) => a.status === "submitted" || a.status === "reviewing").length,
            },
            recent,
        });
    }

    async profile(req: TylixRequest, res: TylixResponse) {
        return res.json({ data: await profileOf(uid(req)) });
    }

    async updateProfile(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const body = (req.body ?? {}) as Row;
        const errors: Record<string, string[]> = {};

        const name = String(body.name ?? "").trim();
        if (!name) errors.name = ["Enter your name."];
        else if (name.length > 120) errors.name = ["Keep it under 120 characters."];

        const phone = String(body.phone ?? "").replace(/[\s-]/g, "");
        if (phone && !PHONE_RE.test(phone)) errors.phone = ["Enter a phone number like 0712 345 678."];

        const preferred = ["phone", "whatsapp", "email"].includes(body.preferredContact) ? body.preferredContact : "phone";
        const lookingFor = ["rent", "buy", "land", "commercial", ""].includes(body.lookingFor ?? "") ? body.lookingFor ?? "" : "";
        const budget = body.budgetMax === null || body.budgetMax === "" || body.budgetMax === undefined ? null : Number(body.budgetMax);
        if (budget !== null && (!Number.isFinite(budget) || budget < 0)) errors.budgetMax = ["Enter a number."];

        if (Object.keys(errors).length > 0) {
            res.status(422);
            return res.json({ errors });
        }

        await User.update(userId, { name });
        await CustomerProfile.updateOrCreate(
            { user_id: userId },
            {
                user_id: userId,
                phone: phone || null,
                preferred_contact: preferred,
                looking_for: lookingFor || null,
                preferred_location: String(body.preferredLocation ?? "").trim().slice(0, 190) || null,
                budget_max: budget,
            },
        );
        return res.json({ data: await profileOf(userId) });
    }

    // ── Saved properties ────────────────────────────────────────────────

    async saved(req: TylixRequest, res: TylixResponse) {
        const rows = (await SavedProperty.where("user_id", uid(req)).latest().get()) as Row[];
        const map = await listingsById(rows.map((r) => Number(r.property_id)));
        const data = rows
            .map((r) => map.get(Number(r.property_id)))
            .filter((l): l is ListingRow => Boolean(l))
            .map((l) => ({ ...presentCard(l), isPublished: Boolean(Number(l.is_published)) }));
        return res.json({ data });
    }

    async savedIds(req: TylixRequest, res: TylixResponse) {
        const rows = (await SavedProperty.where("user_id", uid(req)).get()) as Row[];
        return res.json({ data: rows.map((r) => Number(r.property_id)) });
    }

    async save(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const propertyId = Number(req.body?.property_id);
        const listing = (await Listing.query().where("id", propertyId).where("is_published", 1).first()) as ListingRow | null;
        if (!listing) {
            res.status(404);
            return res.json({ error: "That listing isn't available." });
        }
        await SavedProperty.firstOrCreate({ user_id: userId, property_id: listing.id }, { user_id: userId, property_id: listing.id });
        res.status(201);
        return res.json({ saved: true });
    }

    async unsave(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const row = (await SavedProperty.query().where("user_id", userId).where("property_id", Number(req.params.propertyId)).first()) as Row | null;
        if (row) await SavedProperty.delete(row.id);
        return res.json({ saved: false });
    }

    // ── History ─────────────────────────────────────────────────────────

    async recordView(req: TylixRequest, res: TylixResponse) {
        const propertyId = Number(req.body?.property_id);
        const listing = (await Listing.query().where("id", propertyId).where("is_published", 1).first()) as ListingRow | null;
        if (listing) await PropertyView.create({ property_id: listing.id, user_id: uid(req) });
        res.status(204);
        return res.end();
    }

    async history(req: TylixRequest, res: TylixResponse) {
        const views = (await PropertyView.where("user_id", uid(req)).latest().limit(200).get()) as Row[];
        const lastSeen = new Map<number, string>();
        for (const v of views) {
            const id = Number(v.property_id);
            if (!lastSeen.has(id)) lastSeen.set(id, v.created_at);
        }
        const map = await listingsById([...lastSeen.keys()]);
        const data = [...lastSeen.entries()]
            .map(([id, at]) => {
                const l = map.get(id);
                return l ? { ...presentCard(l), viewedAt: at, isPublished: Boolean(Number(l.is_published)) } : null;
            })
            .filter(Boolean)
            .slice(0, 30);
        return res.json({ data });
    }

    async clearHistory(req: TylixRequest, res: TylixResponse) {
        const views = (await PropertyView.where("user_id", uid(req)).get()) as Row[];
        for (const v of views) await PropertyView.update(v.id, { user_id: null }); // keep the count for reports
        return res.json({ cleared: true });
    }

    // ── Enquiries, viewings, applications ───────────────────────────────

    async activity(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const [enquiries, viewings, applications] = (await Promise.all([
            Enquiry.where("user_id", userId).latest().get(),
            Viewing.where("user_id", userId).latest().get(),
            Application.where("user_id", userId).latest().get(),
        ])) as Row[][];
        const all = [...enquiries, ...viewings, ...applications];
        const map = await listingsById(all.map((r) => Number(r.property_id)));
        const units = await unitNames(all.map((r) => Number(r.unit_id)));

        return res.json({
            enquiries: enquiries.map((r) => ({
                id: r.id, kind: r.kind, status: r.status, message: r.message, createdAt: r.created_at,
                listing: listingRef(map, r.property_id), unit: units.get(Number(r.unit_id)) ?? null,
            })),
            viewings: viewings.map((r) => ({
                id: r.id, status: r.status, preferredDate: r.preferred_date, preferredTime: r.preferred_time,
                scheduledFor: r.scheduled_for, notes: r.notes, createdAt: r.created_at,
                listing: listingRef(map, r.property_id), unit: units.get(Number(r.unit_id)) ?? null,
            })),
            applications: applications.map((r) => ({
                id: r.id, kind: r.kind, status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at,
                offerAmount: r.offer_amount === null ? null : toNumber(r.offer_amount), moveInDate: r.move_in_date,
                listing: listingRef(map, r.property_id), unit: units.get(Number(r.unit_id)) ?? null,
            })),
        });
    }

    async cancelViewing(req: TylixRequest, res: TylixResponse) {
        const row = (await Viewing.query().where("id", Number(req.params.id)).where("user_id", uid(req)).first()) as Row | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Viewing not found." });
        }
        if (row.status !== "requested" && row.status !== "confirmed") {
            res.status(409);
            return res.json({ error: "This viewing can't be cancelled any more." });
        }
        await Viewing.update(row.id, { status: "cancelled" });
        return res.json({ status: "cancelled" });
    }

    async apply(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const body = normaliseContact({ ...(req.body ?? {}), name: req.body?.full_name }) as Row;
        const result = validateApplication(req.body ?? {});
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const listing = (await Listing.query().where("id", Number(body.property_id)).where("is_published", 1).first()) as ListingRow | null;
        if (!listing) {
            res.status(422);
            return res.json({ errors: { property_id: ["That listing isn't available any more."] } });
        }
        const kind = listing.purpose === "sale" ? "purchase" : "rental";

        let unit: UnitRow | null = null;
        if (kind === "rental" && listing.source === "properman") {
            unit = (await ListingUnit.query()
                .where("id", Number(body.unit_id))
                .where("property_id", listing.id)
                .where("is_listed", 1)
                .first()) as UnitRow | null;
            if (!unit) {
                res.status(422);
                return res.json({ errors: { unit_id: ["Pick one of the vacant units."] } });
            }
        }

        const open = (await Application.query()
            .where("user_id", userId)
            .where("property_id", listing.id)
            .whereIn("status", ["submitted", "reviewing"])
            .first()) as Row | null;
        if (open) {
            res.status(409);
            return res.json({ error: "You already have an application in progress for this property." });
        }

        const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
        const app = (await Application.create({
            kind,
            property_id: listing.id,
            unit_id: unit?.id ?? null,
            user_id: userId,
            full_name: String(body.name).slice(0, 160),
            email: String(body.email ?? "").slice(0, 190),
            phone: String(body.phone ?? "").slice(0, 40),
            id_number: String(body.id_number ?? "").trim().slice(0, 40),
            occupation: String(body.occupation ?? "").trim().slice(0, 120) || null,
            employer: String(body.employer ?? "").trim().slice(0, 160) || null,
            monthly_income: num(body.monthly_income),
            offer_amount: kind === "purchase" ? num(body.offer_amount) : null,
            financing: kind === "purchase" ? String(body.financing ?? "cash") : null,
            move_in_date: body.move_in_date || null,
            occupants: num(body.occupants),
            notes: String(body.notes ?? "").trim().slice(0, 2000) || null,
            status: "submitted",
        })) as Row;

        dispatch("NotifyStaff", {
            subject: `New ${kind} application: ${listing.title}`,
            heading: `${kind === "purchase" ? "Purchase" : "Rental"} application for ${listing.title}${unit ? ` (${unit.name})` : ""}`,
            lines: [`From: ${body.name}`, `Phone: ${body.phone}`, `Email: ${body.email}`],
            path: "/admin/applications",
            agentId: listing.agent_id ?? null,
        }).catch((err: unknown) => console.error("[notify] could not queue staff notice:", err));

        res.status(201);
        return res.json({ data: { id: app.id, status: app.status } });
    }

    async withdraw(req: TylixRequest, res: TylixResponse) {
        const row = (await Application.query().where("id", Number(req.params.id)).where("user_id", uid(req)).first()) as Row | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Application not found." });
        }
        if (row.status !== "submitted" && row.status !== "reviewing") {
            res.status(409);
            return res.json({ error: "This application has already been decided." });
        }
        await Application.update(row.id, { status: "withdrawn" });
        return res.json({ status: "withdrawn" });
    }
}
