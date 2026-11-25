// Landlord portal: a landlord signs in exactly like a tenant (account number
// + the phone HQ has on file, proved by an SMS code), with no website
// account, then sees their portfolio, vacant units, payouts and repairs,
// and downloads payout and income statement PDFs.
//
// HQ stays the record for all of it and every view is read-only; nothing
// about landlords is stored here except the session.
//
// The landlord id sent to HQ always comes from the landlord session
// (app/services/LandlordAuth), never from the request.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { Listing } from "../models/Listing.js";
import { Properman, isConfigured } from "../services/Properman.js";
import { currentLandlord, endLandlordSession, startLandlordSession, type LandlordIdentity } from "../services/LandlordAuth.js";
import { firstError, periodRange, redirectTo, signedOut as portalSignedOut, smsLogin, tooMany } from "../services/PortalLogin.js";
import { getSettings } from "../services/site.js";
import { validateLandlordLogin } from "../validators/ListingValidators.js";
import { payoutPdf } from "../pdfs/PayoutPdf.js";
import { incomeStatementPdf } from "../pdfs/IncomeStatementPdf.js";
import { fileSafe, todayIso } from "../pdfs/shared.js";

type Row = Record<string, any>;

const documentLimiter = createRateLimiter({ name: "landlord-documents", max: 30, windowMs: 10 * 60_000, store: "shared" });

const MAX_STATEMENT_YEARS = 5;

function unavailable(res: TylixResponse, err?: unknown) {
    if (err) console.error("[landlord] HQ call failed:", err instanceof Error ? err.message : err);
    res.status(503);
    return res.json({ error: "The landlord portal can't reach the office system right now. Please try again shortly." });
}

function signedOut(res: TylixResponse) {
    return portalSignedOut(res, "LANDLORD_SIGNED_OUT", "Your landlord portal session has ended. Sign in again.");
}

function notFound(res: TylixResponse, message: string) {
    res.status(404);
    return res.json({ error: message });
}

const login = smsLogin<LandlordIdentity>({
    name: "landlord",
    validate: validateLandlordLogin,
    unavailable,
    start: (account, phone, deliverBy) => Properman.startLandlordVerification(account, phone, deliverBy),
    confirm: (account, phone, code) => Properman.confirmLandlordVerification(account, phone, code),
    smsText: (code, ttl) => `Your Barani Better Homes landlord portal code is ${code}. It expires in ${ttl} minutes. Do not share it.`,
    sentMessage: "If those details match a landlord account, we've sent a 6-digit code by SMS to the phone the office has on file.",
    identify: (l) => l.landlord_id
        ? { landlordId: Number(l.landlord_id), name: String(l.name ?? ""), accountNumber: String(l.account_number ?? ""), phone: String(l.phone ?? "") }
        : null,
    startSession: startLandlordSession,
});

// The public listing page for each HQ property, where there is one.
async function listingSlugs(propertyIds: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(propertyIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return new Map();
    const rows = (await Listing.query()
        .where("source", "properman")
        .whereIn("external_id", ids)
        .where("is_published", 1)
        .get()) as Row[];
    return new Map(rows.map((r) => [Number(r.external_id), String(r.slug)]));
}

export class LandlordController {
    // Who is signed in, from the session alone (no HQ call): the site
    // header asks on every page.
    async session(req: TylixRequest, res: TylixResponse) {
        const landlord = await currentLandlord(req);
        return res.json(landlord ? { signedIn: true, name: landlord.name } : { signedIn: false });
    }

    async status(req: TylixRequest, res: TylixResponse) {
        if (!isConfigured()) return res.json({ enabled: false, signedIn: false });
        const landlord = await currentLandlord(req);
        if (!landlord) return res.json({ enabled: true, signedIn: false });

        const who = { name: landlord.name, accountNumber: landlord.accountNumber };
        try {
            const summary = await Properman.landlordSummary(landlord.landlordId);
            if (summary.status === 404) {
                // The landlord was removed in HQ.
                await endLandlordSession(req, res);
                return res.json({ enabled: true, signedIn: false, ended: true, landlord: who });
            }
            if (!summary.ok) return unavailable(res);

            const data = summary.data.data ?? {};
            const slugs = await listingSlugs((data.properties ?? []).map((p: Row) => Number(p.id)));
            data.properties = (data.properties ?? []).map((p: Row) => ({ ...p, listing_slug: slugs.get(Number(p.id)) ?? null }));
            return res.json({ enabled: true, signedIn: true, landlord: who, summary: data });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async startLogin(req: TylixRequest, res: TylixResponse) {
        return login.start(req, res);
    }

    async confirmLogin(req: TylixRequest, res: TylixResponse) {
        return login.confirm(req, res);
    }

    async logout(req: TylixRequest, res: TylixResponse) {
        await endLandlordSession(req, res);
        return res.json({ signedIn: false });
    }

    async units(req: TylixRequest, res: TylixResponse) {
        const landlord = await currentLandlord(req);
        if (!landlord) return signedOut(res);
        try {
            const reply = await Properman.landlordUnits(landlord.landlordId);
            if (!reply.ok) return unavailable(res);
            const units: Row[] = reply.data?.data ?? [];
            const slugs = await listingSlugs(units.map((u) => Number(u.property?.id)));
            return res.json({
                data: units.map((u) => ({ ...u, listing_slug: u.listed_online ? slugs.get(Number(u.property?.id)) ?? null : null })),
            });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async payouts(req: TylixRequest, res: TylixResponse) {
        const landlord = await currentLandlord(req);
        if (!landlord) return signedOut(res);
        try {
            const reply = await Properman.landlordPayouts(landlord.landlordId);
            if (!reply.ok) return unavailable(res);
            return res.json({ data: reply.data?.data ?? [] });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async maintenance(req: TylixRequest, res: TylixResponse) {
        const landlord = await currentLandlord(req);
        if (!landlord) return signedOut(res);
        try {
            const reply = await Properman.landlordMaintenance(landlord.landlordId);
            if (!reply.ok) return unavailable(res);
            return res.json({ data: reply.data?.data ?? [] });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async payoutPdf(req: TylixRequest, res: TylixResponse) {
        const landlord = await currentLandlord(req);
        if (!landlord) return redirectTo(res, "/landlord");
        if (!(await documentLimiter(`l:${landlord.landlordId}`)).allowed) return tooMany(res, "Too many downloads. Wait a few minutes and try again.");

        const payoutId = Number(req.params.id);
        if (!Number.isInteger(payoutId) || payoutId < 1) return notFound(res, "Payout not found.");

        try {
            // HQ only answers for a payout made to this landlord.
            const reply = await Properman.landlordPayout(landlord.landlordId, payoutId);
            if (reply.status === 404) return notFound(res, "Payout not found.");
            if (!reply.ok || !reply.data?.data) return unavailable(res);

            const payout = reply.data.data;
            const pdf = payoutPdf(payout, await getSettings());
            res.setHeader("Cache-Control", "private, no-store");
            const name = `payout-${fileSafe(payout.property?.name)}-${fileSafe(payout.period)}.pdf`;
            return await res.download(pdf, name, { inline: req.query.download !== "1" });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    // ?from=YYYY-MM-DD&to=YYYY-MM-DD (to defaults to today).
    async statementPdf(req: TylixRequest, res: TylixResponse) {
        const landlord = await currentLandlord(req);
        if (!landlord) return redirectTo(res, "/landlord");

        const range = periodRange(req.query.from, req.query.to, todayIso(), MAX_STATEMENT_YEARS);
        if ("error" in range) {
            res.status(422);
            return res.json({ errors: { [range.field]: [range.error] } });
        }
        if (!(await documentLimiter(`l:${landlord.landlordId}`)).allowed) return tooMany(res, "Too many downloads. Wait a few minutes and try again.");

        try {
            const reply = await Properman.landlordStatement(landlord.landlordId, range.from, range.to);
            if (reply.status === 422) {
                res.status(422);
                return res.json({ error: firstError(reply.data) ?? "Choose a valid period." });
            }
            if (!reply.ok || !reply.data?.data) return unavailable(res);

            const pdf = incomeStatementPdf(reply.data.data, await getSettings());
            res.setHeader("Cache-Control", "private, no-store");
            const name = `income-statement-${fileSafe(landlord.accountNumber)}-${range.from}-to-${range.to}.pdf`;
            return await res.download(pdf, name, { inline: req.query.download !== "1" });
        } catch (err) {
            return unavailable(res, err);
        }
    }
}
