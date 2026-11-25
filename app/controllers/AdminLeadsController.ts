// Administration API for customer-facing work: enquiries, viewing requests,
// applications and customer accounts. Guarded in app/routes/admin.ts.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Enquiry } from "../models/Enquiry.js";
import { Viewing } from "../models/Viewing.js";
import { Application } from "../models/Application.js";
import { Listing } from "../models/Listing.js";
import { ListingUnit } from "../models/ListingUnit.js";
import { Agent } from "../models/Agent.js";
import { User } from "../models/User.js";
import { CustomerProfile } from "../models/CustomerProfile.js";
import { SavedProperty } from "../models/SavedProperty.js";
import { TenantLink } from "../models/TenantLink.js";
import { APPLICATION_STATUSES, ENQUIRY_STATUSES, VIEWING_STATUSES, toNumber, type ListingRow, type UnitRow } from "../services/catalog.js";

type Row = Record<string, any>;

async function lookups(rows: Row[]) {
    const ids = (key: string) => [...new Set(rows.map((r) => Number(r[key])).filter((n) => Number.isInteger(n) && n > 0))];
    const listingIds = ids("property_id");
    const unitIds = ids("unit_id");
    const agentIds = ids("agent_id");
    const listings = listingIds.length ? ((await Listing.query().whereIn("id", listingIds).get()) as ListingRow[]) : [];
    const units = unitIds.length ? ((await ListingUnit.query().whereIn("id", unitIds).get()) as UnitRow[]) : [];
    const agents = agentIds.length ? ((await Agent.query().whereIn("id", agentIds).get()) as Row[]) : [];
    return {
        listing: (id: unknown) => {
            const l = listings.find((x) => x.id === Number(id));
            return l ? { id: l.id, slug: l.slug, title: l.title, source: l.source } : null;
        },
        unit: (id: unknown) => units.find((x) => x.id === Number(id))?.name ?? null,
        agent: (id: unknown) => agents.find((x) => x.id === Number(id))?.name ?? null,
    };
}

function statusFilter(query: any, value: unknown, allowed: readonly string[]): any {
    return allowed.includes(String(value)) ? query.where("status", String(value)) : query;
}

async function validAgentId(value: unknown): Promise<number | null> {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    return (await Agent.find(id)) ? id : null;
}

export class AdminLeadsController {
    // ── Enquiries ───────────────────────────────────────────────────────

    async enquiries(req: TylixRequest, res: TylixResponse) {
        let query = statusFilter(Enquiry.query(), req.query?.status, ENQUIRY_STATUSES);
        if (["general", "rental", "purchase"].includes(String(req.query?.kind))) query = query.where("kind", String(req.query?.kind));
        const rows = (await query.latest().limit(500).get()) as Row[];
        const look = await lookups(rows);
        return res.json({
            data: rows.map((r) => ({
                id: r.id, kind: r.kind, status: r.status, name: r.name, email: r.email, phone: r.phone,
                message: r.message, adminNotes: r.admin_notes ?? "", createdAt: r.created_at, updatedAt: r.updated_at,
                isCustomer: Boolean(r.user_id), listing: look.listing(r.property_id), unit: look.unit(r.unit_id),
                agentId: r.agent_id, agent: look.agent(r.agent_id),
            })),
        });
    }

    async updateEnquiry(req: TylixRequest, res: TylixResponse) {
        const row = (await Enquiry.find(Number(req.params.id))) as Row | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Enquiry not found." });
        }
        const body = (req.body ?? {}) as Row;
        const updates: Row = {};
        if ("status" in body) {
            if (!ENQUIRY_STATUSES.includes(body.status)) {
                res.status(422);
                return res.json({ errors: { status: ["Unknown status."] } });
            }
            updates.status = body.status;
        }
        if ("adminNotes" in body) updates.admin_notes = String(body.adminNotes ?? "").slice(0, 3000) || null;
        if ("agentId" in body) updates.agent_id = await validAgentId(body.agentId);
        if (Object.keys(updates).length) await Enquiry.update(row.id, updates);
        return res.json({ ok: true });
    }

    // ── Viewings ────────────────────────────────────────────────────────

    async viewings(req: TylixRequest, res: TylixResponse) {
        const query = statusFilter(Viewing.query(), req.query?.status, VIEWING_STATUSES);
        const rows = (await query.orderBy("preferred_date", "DESC").limit(500).get()) as Row[];
        const look = await lookups(rows);
        return res.json({
            data: rows.map((r) => ({
                id: r.id, status: r.status, name: r.name, email: r.email, phone: r.phone,
                preferredDate: r.preferred_date, preferredTime: r.preferred_time, scheduledFor: r.scheduled_for,
                notes: r.notes ?? "", adminNotes: r.admin_notes ?? "", createdAt: r.created_at,
                listing: look.listing(r.property_id), unit: look.unit(r.unit_id), agentId: r.agent_id, agent: look.agent(r.agent_id),
            })),
        });
    }

    async updateViewing(req: TylixRequest, res: TylixResponse) {
        const row = (await Viewing.find(Number(req.params.id))) as Row | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Viewing not found." });
        }
        const body = (req.body ?? {}) as Row;
        const updates: Row = {};
        if ("status" in body) {
            if (!VIEWING_STATUSES.includes(body.status)) {
                res.status(422);
                return res.json({ errors: { status: ["Unknown status."] } });
            }
            updates.status = body.status;
        }
        if ("scheduledFor" in body) {
            const when = String(body.scheduledFor ?? "");
            if (when && Number.isNaN(Date.parse(when))) {
                res.status(422);
                return res.json({ errors: { scheduledFor: ["Pick a date and time."] } });
            }
            updates.scheduled_for = when || null;
            if (when && row.status === "requested" && !("status" in body)) updates.status = "confirmed";
        }
        if ("adminNotes" in body) updates.admin_notes = String(body.adminNotes ?? "").slice(0, 3000) || null;
        if ("agentId" in body) updates.agent_id = await validAgentId(body.agentId);
        if (Object.keys(updates).length) await Viewing.update(row.id, updates);
        return res.json({ ok: true });
    }

    // ── Applications ────────────────────────────────────────────────────

    async applications(req: TylixRequest, res: TylixResponse) {
        let query = statusFilter(Application.query(), req.query?.status, APPLICATION_STATUSES);
        if (["rental", "purchase"].includes(String(req.query?.kind))) query = query.where("kind", String(req.query?.kind));
        const rows = (await query.latest().limit(500).get()) as Row[];
        const look = await lookups(rows);
        return res.json({
            data: rows.map((r) => ({
                id: r.id, kind: r.kind, status: r.status, fullName: r.full_name, email: r.email, phone: r.phone,
                idNumber: r.id_number, occupation: r.occupation ?? "", employer: r.employer ?? "",
                monthlyIncome: r.monthly_income === null ? null : toNumber(r.monthly_income),
                offerAmount: r.offer_amount === null ? null : toNumber(r.offer_amount),
                financing: r.financing, moveInDate: r.move_in_date, occupants: r.occupants, notes: r.notes ?? "",
                reviewNotes: r.review_notes ?? "", reviewedAt: r.reviewed_at, createdAt: r.created_at,
                listing: look.listing(r.property_id), unit: look.unit(r.unit_id),
            })),
        });
    }

    async updateApplication(req: TylixRequest, res: TylixResponse) {
        const row = (await Application.find(Number(req.params.id))) as Row | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Application not found." });
        }
        const body = (req.body ?? {}) as Row;
        const updates: Row = {};
        if ("status" in body) {
            if (!APPLICATION_STATUSES.includes(body.status) || body.status === "withdrawn") {
                res.status(422);
                return res.json({ errors: { status: ["Unknown status."] } });
            }
            if (row.status === "withdrawn") {
                res.status(409);
                return res.json({ error: "The applicant withdrew this application." });
            }
            updates.status = body.status;
            updates.reviewed_by = Number(req.user?.userId) || null;
            updates.reviewed_at = new Date().toISOString();
        }
        if ("reviewNotes" in body) updates.review_notes = String(body.reviewNotes ?? "").slice(0, 3000) || null;
        if (Object.keys(updates).length) await Application.update(row.id, updates);
        return res.json({ ok: true });
    }

    // ── Customers ───────────────────────────────────────────────────────

    async customers(req: TylixRequest, res: TylixResponse) {
        const q = String(req.query?.q ?? "").trim().toLowerCase();
        let users = (await User.query().orderBy("created_at", "DESC").get()) as Row[];
        if (q) users = users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q));
        users = users.slice(0, 300);

        const [profiles, saves, enquiries, applications, links] = (await Promise.all([
            CustomerProfile.all(),
            SavedProperty.all(),
            Enquiry.query().whereNotNull("user_id").get(),
            Application.all(),
            TenantLink.all(),
        ])) as Row[][];

        return res.json({
            data: users.map((u) => {
                const profile = profiles.find((p) => Number(p.user_id) === u.id);
                return {
                    id: u.id, name: u.name, email: u.email, verified: Boolean(u.email_verified_at), createdAt: u.created_at,
                    phone: profile?.phone ?? "", lookingFor: profile?.looking_for ?? "",
                    saved: saves.filter((s) => Number(s.user_id) === u.id).length,
                    enquiries: enquiries.filter((e) => Number(e.user_id) === u.id).length,
                    applications: applications.filter((a) => Number(a.user_id) === u.id).length,
                    isTenant: links.some((l) => Number(l.user_id) === u.id),
                };
            }),
        });
    }
}
