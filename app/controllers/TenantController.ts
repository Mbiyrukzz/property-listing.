// Tenant portal: a tenant signs in with their account number and the phone
// on file (SMS code), with no website account, then reads balances,
// invoices and receipts, downloads invoice and statement PDFs, pays rent by
// M-Pesa, and reports repairs (maintenance requests go to HQ's queue).
//
// Properman stays the record for rent and repairs: balances, receipts and
// requests are read from it on each visit, and payments go through
// Properman's own STK flow, which applies the money and sends the receipt
// SMS. Barani Better Homes keeps only a rent_payments row so the tenant can
// follow the request.
//
// The tenant id sent to Properman always comes from the tenant session
// (app/services/TenantAuth), never from the request.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { RentPayment } from "../models/RentPayment.js";
import { Properman, isConfigured } from "../services/Properman.js";
import { currentTenant, endTenantSession, startTenantSession, type CurrentTenant, type TenantIdentity } from "../services/TenantAuth.js";
import { firstError, periodRange, redirectTo, signedOut as portalSignedOut, smsLogin, tooMany, unprocessable } from "../services/PortalLogin.js";
import { getSettings } from "../services/site.js";
import { validateMaintenance, validatePayment, validateTenantLogin } from "../validators/ListingValidators.js";
import { invoicePdf } from "../pdfs/InvoicePdf.js";
import { statementPdf } from "../pdfs/StatementPdf.js";
import { fileSafe, todayIso } from "../pdfs/shared.js";

type Row = Record<string, any>;

const payLimiter = createRateLimiter({ name: "tenant-pay", max: 5, windowMs: 10 * 60_000, store: "shared" });
const documentLimiter = createRateLimiter({ name: "tenant-documents", max: 30, windowMs: 10 * 60_000, store: "shared" });
const maintenanceLimiter = createRateLimiter({ name: "tenant-maintenance", max: 5, windowMs: 60 * 60_000, store: "shared" });

const MAX_STATEMENT_YEARS = 5;

function unavailable(res: TylixResponse, err?: unknown) {
    if (err) console.error("[tenant] HQ call failed:", err instanceof Error ? err.message : err);
    res.status(503);
    return res.json({ error: "The tenant portal can't reach the rent system right now. Please try again shortly." });
}

function signedOut(res: TylixResponse) {
    return portalSignedOut(res, "TENANT_SIGNED_OUT", "Your tenant portal session has ended. Sign in again.");
}

function backToPortal(res: TylixResponse) {
    redirectTo(res, "/tenant");
}

const login = smsLogin<TenantIdentity>({
    name: "tenant",
    validate: validateTenantLogin,
    unavailable,
    start: (account, phone, deliverBy) => Properman.startTenantVerification(account, phone, deliverBy),
    confirm: (account, phone, code) => Properman.confirmTenantVerification(account, phone, code),
    smsText: (code, ttl) => `Your Barani Better Homes tenant portal code is ${code}. It expires in ${ttl} minutes. Do not share it.`,
    sentMessage: "If those details match your tenancy, we've sent a 6-digit code by SMS to the phone your landlord has on file.",
    identify: (t) => t.tenant_id
        ? { tenantId: Number(t.tenant_id), name: String(t.name ?? ""), accountNumber: String(t.account_number ?? ""), phone: String(t.phone ?? "") }
        : null,
    startSession: startTenantSession,
});

export class TenantController {
    // Who is signed in, from the session alone (no HQ call): the site
    // header asks on every page.
    async session(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        return res.json(tenant ? { signedIn: true, name: tenant.name } : { signedIn: false });
    }

    async status(req: TylixRequest, res: TylixResponse) {
        if (!isConfigured()) return res.json({ enabled: false, signedIn: false });
        const tenant = await currentTenant(req);
        if (!tenant) return res.json({ enabled: true, signedIn: false });

        const who = { name: tenant.name, accountNumber: tenant.accountNumber };
        try {
            const summary = await Properman.tenantSummary(tenant.tenantId);
            if (summary.status === 404) {
                // The tenancy is gone in Properman (moved out and removed).
                await endTenantSession(req, res);
                return res.json({ enabled: true, signedIn: false, ended: true, tenant: who });
            }
            if (!summary.ok) return unavailable(res);
            return res.json({ enabled: true, signedIn: true, tenant: who, summary: summary.data.data });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    // Step 1: account number + phone. Texts a code if they match a tenancy.
    async startLogin(req: TylixRequest, res: TylixResponse) {
        return login.start(req, res);
    }

    // Step 2: the code. Starts a tenant session (cookie) when it's right.
    async confirmLogin(req: TylixRequest, res: TylixResponse) {
        return login.confirm(req, res);
    }

    async logout(req: TylixRequest, res: TylixResponse) {
        await endTenantSession(req, res);
        return res.json({ signedIn: false });
    }

    async invoices(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);
        try {
            const reply = await Properman.tenantInvoices(tenant.tenantId);
            if (!reply.ok) return unavailable(res);
            return res.json({ data: reply.data.data ?? [] });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async invoicePdf(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return backToPortal(res);
        if (!(await documentLimiter(`t:${tenant.tenantId}`)).allowed) return tooMany(res, "Too many downloads. Wait a few minutes and try again.");

        const invoiceId = Number(req.params.id);
        if (!Number.isInteger(invoiceId) || invoiceId < 1) {
            res.status(404);
            return res.json({ error: "Invoice not found." });
        }

        try {
            // Properman only answers for an invoice of this tenant.
            const reply = await Properman.tenantInvoice(tenant.tenantId, invoiceId);
            if (reply.status === 404) {
                res.status(404);
                return res.json({ error: "Invoice not found." });
            }
            if (!reply.ok || !reply.data?.data) return unavailable(res);

            const invoice = reply.data.data;
            const pdf = invoicePdf(invoice, await getSettings());
            res.setHeader("Cache-Control", "private, no-store");
            return await res.download(pdf, `invoice-${fileSafe(invoice.invoice_number ?? invoiceId)}.pdf`, { inline: req.query.download !== "1" });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    // ?from=YYYY-MM-DD&to=YYYY-MM-DD (to defaults to today).
    async statementPdf(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return backToPortal(res);

        const range = this.statementRange(req.query.from, req.query.to);
        if ("error" in range) {
            res.status(422);
            return res.json({ errors: { [range.field]: [range.error] } });
        }
        if (!(await documentLimiter(`t:${tenant.tenantId}`)).allowed) return tooMany(res, "Too many downloads. Wait a few minutes and try again.");

        try {
            const reply = await Properman.tenantStatement(tenant.tenantId, range.from, range.to);
            if (reply.status === 422) {
                res.status(422);
                return res.json({ error: firstError(reply.data) ?? "Choose a valid period." });
            }
            if (!reply.ok || !reply.data?.data) return unavailable(res);

            const pdf = statementPdf(reply.data.data, await getSettings());
            res.setHeader("Cache-Control", "private, no-store");
            const name = `statement-${fileSafe(tenant.accountNumber)}-${range.from}-to-${range.to}.pdf`;
            return await res.download(pdf, name, { inline: req.query.download !== "1" });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    statementRange(fromValue: unknown, toValue: unknown) {
        return periodRange(fromValue, toValue, todayIso(), MAX_STATEMENT_YEARS);
    }

    async payments(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);
        try {
            const reply = await Properman.tenantPayments(tenant.tenantId);
            if (!reply.ok) return unavailable(res);
            const requests = (await RentPayment.query()
                .where("properman_tenant_id", tenant.tenantId)
                .latest()
                .limit(20)
                .get()) as Row[];
            return res.json({
                receipts: reply.data.data ?? [],
                requests: requests.map((r) => ({
                    id: r.id, amount: Number(r.amount), phone: r.phone, status: r.status,
                    mpesaReceipt: r.mpesa_receipt, message: r.message, createdAt: r.created_at,
                })),
            });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async pay(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);
        if (!(await payLimiter(`t:${tenant.tenantId}`)).allowed) {
            return tooMany(res, "Several payment requests were sent recently. Wait a few minutes.");
        }

        const result = validatePayment(req.body ?? {});
        if (!result.valid) return unprocessable(res, result.errors ?? {});

        const phone = String(req.body.phone).replace(/[\s-]/g, "");
        const amount = Math.round(Number(req.body.amount));

        try {
            const reply = await Properman.stkPush(tenant.tenantId, phone, amount);
            const paymentId = Number(reply.data?.data?.payment_id ?? reply.data?.payment_id) || null;
            const accepted = reply.status === 201;

            const row = (await RentPayment.create({
                user_id: null,
                properman_tenant_id: tenant.tenantId,
                properman_payment_id: paymentId,
                amount,
                phone,
                status: accepted ? "pending" : "failed",
                message: String(reply.data?.data?.message ?? firstError(reply.data) ?? "").slice(0, 255) || null,
            })) as Row;

            if (accepted) {
                res.status(201);
                return res.json({ data: { id: row.id, status: "pending", message: reply.data.data.message } });
            }
            if (reply.status === 409 || reply.status === 422) {
                res.status(reply.status);
                return res.json({ error: firstError(reply.data) ?? "M-Pesa refused the request." });
            }
            return unavailable(res);
        } catch (err) {
            return unavailable(res, err);
        }
    }

    // Polled by the portal after "Pay" until the tenant finishes on their phone.
    async paymentStatus(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);
        const row = await this.ownPayment(tenant, Number(req.params.id));
        if (!row) {
            res.status(404);
            return res.json({ error: "Payment not found." });
        }

        if (row.status === "pending" && row.properman_payment_id) {
            try {
                const reply = await Properman.paymentStatus(tenant.tenantId, Number(row.properman_payment_id));
                if (reply.ok && reply.data?.data) {
                    const s = reply.data.data;
                    const status = ["completed", "failed"].includes(s.status) ? s.status : "pending";
                    if (status !== row.status) {
                        await RentPayment.update(row.id, {
                            status,
                            mpesa_receipt: s.mpesa_receipt ?? null,
                            message: String(s.failure_reason ?? "").slice(0, 255) || row.message,
                        });
                        row.status = status;
                        row.mpesa_receipt = s.mpesa_receipt ?? null;
                        row.message = s.failure_reason ?? row.message;
                    }
                }
            } catch (err) {
                console.error("[tenant] payment status check failed:", err instanceof Error ? err.message : err);
            }
        }

        return res.json({
            data: { id: row.id, status: row.status, amount: Number(row.amount), mpesaReceipt: row.mpesa_receipt, message: row.message },
        });
    }

    // Maintenance requests: HQ keeps them; the tenant sees their own.
    async maintenance(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);
        try {
            const reply = await Properman.tenantMaintenance(tenant.tenantId);
            if (!reply.ok) return unavailable(res);
            return res.json({ data: reply.data?.data ?? [] });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async reportMaintenance(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);

        const body = req.body ?? {};
        const result = validateMaintenance(body);
        if (!result.valid) return unprocessable(res, result.errors ?? {});
        if (!(await maintenanceLimiter(`t:${tenant.tenantId}`)).allowed) {
            return tooMany(res, "You've sent several requests in the last hour. Call the office if it's an emergency.");
        }

        try {
            const reply = await Properman.createTenantMaintenance(tenant.tenantId, {
                title: String(body.title).trim(),
                description: String(body.description).trim(),
                category: body.category,
                priority: body.priority,
                reported_contact: String(body.reported_contact ?? "").replace(/[\s-]/g, "") || tenant.phone,
            });
            if (reply.status === 422) {
                res.status(422);
                return res.json(reply.data?.errors ? { errors: reply.data.errors } : { error: firstError(reply.data) ?? "Check the details and try again." });
            }
            if (!reply.ok || !reply.data?.data) return unavailable(res);
            res.status(reply.status === 201 ? 201 : 200);
            return res.json({ data: reply.data.data, duplicate: Boolean(reply.data.duplicate) });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async cancelMaintenance(req: TylixRequest, res: TylixResponse) {
        const tenant = await currentTenant(req);
        if (!tenant) return signedOut(res);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) {
            res.status(404);
            return res.json({ error: "Request not found." });
        }
        try {
            // HQ only cancels a request of this tenant that nobody has picked up.
            const reply = await Properman.cancelTenantMaintenance(tenant.tenantId, id);
            if (reply.status === 404 || reply.status === 409) {
                res.status(reply.status);
                return res.json({ error: firstError(reply.data) ?? "That request can't be cancelled." });
            }
            if (!reply.ok || !reply.data?.data) return unavailable(res);
            return res.json({ data: reply.data.data });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async ownPayment(tenant: CurrentTenant, id: number): Promise<Row | null> {
        if (!Number.isInteger(id) || id < 1) return null;
        return (await RentPayment.query()
            .where("id", id)
            .where("properman_tenant_id", tenant.tenantId)
            .first()) as Row | null;
    }
}
