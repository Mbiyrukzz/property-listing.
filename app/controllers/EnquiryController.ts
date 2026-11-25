// Enquiries and viewing requests. The same handlers serve guests (public
// routes) and signed-in customers (/api/account/...), who get the request
// linked to their account so it shows on their dashboard.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter, dispatch } from "@tylix/core";
import { Enquiry } from "../models/Enquiry.js";
import { Viewing } from "../models/Viewing.js";
import { Listing } from "../models/Listing.js";
import { ListingUnit } from "../models/ListingUnit.js";
import { clientIp } from "../services/http.js";
import { normaliseContact, validateEnquiry, validateViewing } from "../validators/ListingValidators.js";
import type { ListingRow, UnitRow } from "../services/catalog.js";

const formLimiter = createRateLimiter({ name: "public-forms", max: 8, windowMs: 10 * 60_000, store: "shared" });

function clean(value: unknown, max: number): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text.slice(0, max) : null;
}

async function listingAndUnit(propertyId: unknown, unitId: unknown) {
    const id = Number(propertyId);
    const listing = Number.isInteger(id) && id > 0
        ? ((await Listing.query().where("id", id).where("is_published", 1).first()) as ListingRow | null)
        : null;
    let unit: UnitRow | null = null;
    const uid = Number(unitId);
    if (listing && Number.isInteger(uid) && uid > 0) {
        unit = (await ListingUnit.query().where("id", uid).where("property_id", listing.id).first()) as UnitRow | null;
    }
    return { listing, unit };
}

async function limited(req: TylixRequest, res: TylixResponse): Promise<boolean> {
    const key = req.user?.userId ? `u:${req.user.userId}` : `ip:${clientIp(req)}`;
    if (!(await formLimiter(key)).allowed) {
        res.status(429);
        res.json({ error: "You've sent several requests in a short time. Please wait a few minutes or call us." });
        return true;
    }
    return false;
}

function queueNotice(notice: Record<string, unknown>) {
    dispatch("NotifyStaff", notice).catch((err: unknown) => console.error("[notify] could not queue staff notice:", err));
}

export class EnquiryController {
    async storeEnquiry(req: TylixRequest, res: TylixResponse) {
        if (await limited(req, res)) return;

        const result = validateEnquiry(req.body ?? {});
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const body = normaliseContact(req.body ?? {}) as Record<string, unknown>;
        const { listing, unit } = await listingAndUnit(body.property_id, body.unit_id);
        if (body.property_id && !listing) {
            res.status(422);
            return res.json({ errors: { property_id: ["That listing isn't available any more."] } });
        }

        const kind = listing ? (listing.purpose === "sale" ? "purchase" : "rental") : "general";
        const enquiry = (await Enquiry.create({
            kind,
            property_id: listing?.id ?? null,
            unit_id: unit?.id ?? null,
            user_id: req.user?.userId ?? null,
            agent_id: listing?.agent_id ?? null,
            name: clean(body.name, 120),
            email: clean(body.email, 190),
            phone: clean(body.phone, 40),
            message: clean(body.message, 3000),
            status: "new",
        })) as Record<string, any>;

        queueNotice({
            subject: listing ? `New enquiry: ${listing.title}` : "New enquiry from the website",
            heading: listing ? `Enquiry about ${listing.title}${unit ? ` (${unit.name})` : ""}` : "General enquiry",
            lines: [`From: ${body.name}`, `Phone: ${body.phone}`, body.email ? `Email: ${body.email}` : "", "", String(body.message ?? "")].filter((l) => l !== ""),
            path: "/admin/enquiries",
            agentId: listing?.agent_id ?? null,
        });

        res.status(201);
        return res.json({ data: { id: enquiry.id }, message: "Thanks, we'll be in touch shortly." });
    }

    async storeViewing(req: TylixRequest, res: TylixResponse) {
        if (await limited(req, res)) return;

        const result = validateViewing(req.body ?? {});
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const body = normaliseContact(req.body ?? {}) as Record<string, unknown>;
        const { listing, unit } = await listingAndUnit(body.property_id, body.unit_id);
        if (!listing) {
            res.status(422);
            return res.json({ errors: { property_id: ["That listing isn't available any more."] } });
        }

        const today = new Date().toISOString().slice(0, 10);
        if (String(body.preferred_date) < today) {
            res.status(422);
            return res.json({ errors: { preferred_date: ["Pick today or a later day."] } });
        }

        const viewing = (await Viewing.create({
            property_id: listing.id,
            unit_id: unit?.id ?? null,
            user_id: req.user?.userId ?? null,
            agent_id: listing.agent_id ?? null,
            name: clean(body.name, 120),
            email: clean(body.email, 190),
            phone: clean(body.phone, 40),
            preferred_date: String(body.preferred_date),
            preferred_time: clean(body.preferred_time, 20) ?? "morning",
            notes: clean(body.notes, 1000),
            status: "requested",
        })) as Record<string, any>;

        queueNotice({
            subject: `Viewing request: ${listing.title}`,
            heading: `Viewing request for ${listing.title}${unit ? ` (${unit.name})` : ""}`,
            lines: [
                `From: ${body.name}`,
                `Phone: ${body.phone}`,
                `Preferred: ${body.preferred_date}, ${body.preferred_time ?? "morning"}`,
                body.notes ? `Notes: ${body.notes}` : "",
            ].filter((l) => l !== ""),
            path: "/admin/viewings",
            agentId: listing.agent_id ?? null,
        });

        res.status(201);
        return res.json({ data: { id: viewing.id }, message: "Viewing requested. We'll call you to confirm the time." });
    }
}
