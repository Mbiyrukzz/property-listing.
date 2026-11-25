// Tenant portal: a tenant signs in with their account number and the phone
// on file (SMS code), with no website account, then reads balances,
// invoices and receipts, downloads invoice and statement PDFs, and pays
// rent by M-Pesa.
//
// Properman stays the record for rent: balances and receipts are read from it
// on each visit, and payments go through Properman's own STK flow, which
// applies the money and sends the receipt SMS. Barani Better Homes keeps only a
// rent_payments row so the tenant can follow the request.
//
// The tenant id sent to Properman always comes from the tenant session
// (app/services/TenantAuth), never from the request.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { RentPayment } from "../models/RentPayment.js";
import { Properman, isConfigured } from "../services/Properman.js";
import { sendSms, smsConfigured } from "../services/Sms.js";
import { currentTenant, endTenantSession, startTenantSession, type CurrentTenant } from "../services/TenantAuth.js";
import { getSettings } from "../services/site.js";
import { validatePayment, validateTenantLogin } from "../validators/ListingValidators.js";
import { invoicePdf } from "../pdfs/InvoicePdf.js";
import { statementPdf } from "../pdfs/StatementPdf.js";
import { fileSafe, todayIso } from "../pdfs/shared.js";

type Row = Record<string, any>;

// Sign-in is open to anyone, so it is limited per address and per account.
const loginIpLimiter = createRateLimiter({ name: "tenant-login-ip", max: 10, windowMs: 15 * 60_000, store: "shared" });
const loginAccountLimiter = createRateLimiter({ name: "tenant-login-account", max: 5, windowMs: 15 * 60_000, store: "shared" });
const confirmIpLimiter = createRateLimiter({ name: "tenant-confirm-ip", max: 20, windowMs: 15 * 60_000, store: "shared" });
const confirmAccountLimiter = createRateLimiter({ name: "tenant-confirm-account", max: 10, windowMs: 15 * 60_000, store: "shared" });
const payLimiter = createRateLimiter({ name: "tenant-pay", max: 5, windowMs: 10 * 60_000, store: "shared" });
const documentLimiter = createRateLimiter({ name: "tenant-documents", max: 30, windowMs: 10 * 60_000, store: "shared" });

const MAX_STATEMENT_YEARS = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clientIp(req: TylixRequest): string {
    return String((req as unknown as { ip?: string }).ip ?? "unknown");
}

function accountKey(value: unknown): string {
    return String(value ?? "").trim().toLowerCase().slice(0, 60);
}

function tooMany(res: TylixResponse, message = "Too many attempts. Wait 15 minutes and try again.") {
    res.status(429);
    return res.json({ error: message });
}

function unavailable(res: TylixResponse, err?: unknown) {
    if (err) console.error("[tenant] HQ call failed:", err instanceof Error ? err.message : err);
    res.status(503);
    return res.json({ error: "The tenant portal can't reach the rent system right now. Please try again shortly." });
}

// 403 rather than 401: the frontend client answers a 401 by refreshing the
// website-account session, which has nothing to do with this one.
function signedOut(res: TylixResponse) {
    res.status(403);
    return res.json({ error: "Your tenant portal session has ended. Sign in again.", code: "TENANT_SIGNED_OUT" });
}

// PDFs open in a new tab, so a signed-out visitor goes back to the sign-in.
function backToPortal(res: TylixResponse) {
    res.statusCode = 302;
    res.setHeader("Location", "/tenant");
    res.setHeader("Cache-Control", "no-store");
    res.end();
}

function firstError(data: any): string | null {
    const errors = data?.errors;
    if (errors && typeof errors === "object") {
        const key = Object.keys(errors)[0];
        if (key && Array.isArray(errors[key])) return String(errors[key][0]);
    }
    return typeof data?.error === "string" ? data.error : null;
}

function isRealDate(text: string): boolean {
    if (!DATE_RE.test(text)) return false;
    const d = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

export class TenantController {
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
        if (!isConfigured()) return unavailable(res);
        if (!(await loginIpLimiter(clientIp(req))).allowed) return tooMany(res);

        const result = validateTenantLogin(req.body ?? {});
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }
        if (!(await loginAccountLimiter(accountKey(req.body.account_number))).allowed) return tooMany(res);

        try {
            // With Ashmif set up, this app texts the code itself; otherwise
            // Properman sends it through its own SMS provider.
            const ownSms = smsConfigured();
            const reply = await Properman.startTenantVerification(
                String(req.body.account_number).trim(),
                String(req.body.phone).replace(/[\s-]/g, ""),
                ownSms ? "caller" : "properman",
            );
            if (reply.status === 429) return tooMany(res, "Too many attempts. Wait a few minutes and try again.");
            if (!reply.ok) return unavailable(res);

            // `delivery` is only present when the details matched a tenancy
            // and a fresh code was issued. It never goes back to the browser,
            // so the reply below is the same either way.
            const delivery = reply.data?.delivery;
            if (ownSms && delivery?.code && delivery?.phone) {
                const ttl = Number(delivery.ttl_minutes) || 10;
                const sent = await sendSms(
                    String(delivery.phone),
                    `Your Barani Better Homes tenant portal code is ${delivery.code}. It expires in ${ttl} minutes. Do not share it.`,
                );
                if (!sent) console.error("[tenant] sign-in SMS was not delivered");
            }
            return res.json({
                sent: true,
                message: "If those details match your tenancy, we've sent a 6-digit code by SMS to the phone your landlord has on file.",
            });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    // Step 2: the code. Starts a tenant session (cookie) when it's right.
    async confirmLogin(req: TylixRequest, res: TylixResponse) {
        if (!isConfigured()) return unavailable(res);
        if (!(await confirmIpLimiter(clientIp(req))).allowed) return tooMany(res);

        const result = validateTenantLogin(req.body ?? {});
        const code = String(req.body?.code ?? "").trim();
        if (!result.valid || !/^\d{6}$/.test(code)) {
            res.status(422);
            return res.json({ errors: { ...(result.errors ?? {}), ...(/^\d{6}$/.test(code) ? {} : { code: ["Enter the 6-digit code."] }) } });
        }
        if (!(await confirmAccountLimiter(accountKey(req.body.account_number))).allowed) return tooMany(res);

        try {
            const reply = await Properman.confirmTenantVerification(
                String(req.body.account_number).trim(),
                String(req.body.phone).replace(/[\s-]/g, ""),
                code,
            );
            if (reply.status === 422) {
                res.status(422);
                return res.json({ errors: { code: [firstError(reply.data) ?? "That code is wrong or has expired."] } });
            }
            if (!reply.ok || !reply.data?.data?.tenant_id) return unavailable(res);

            const t = reply.data.data;
            await startTenantSession(req, res, {
                tenantId: Number(t.tenant_id),
                name: String(t.name ?? ""),
                accountNumber: String(t.account_number ?? ""),
                phone: String(t.phone ?? ""),
            });
            return res.json({ signedIn: true });
        } catch (err) {
            return unavailable(res, err);
        }
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

    statementRange(fromValue: unknown, toValue: unknown): { from: string; to: string } | { field: string; error: string } {
        const today = todayIso();
        const from = String(fromValue ?? "").trim();
        const to = String(toValue ?? "").trim() || today;
        if (!isRealDate(from)) return { field: "from", error: "Choose a start date." };
        if (!isRealDate(to)) return { field: "to", error: "Choose an end date." };
        if (from > to) return { field: "from", error: "The start date must be before the end date." };
        if (from > today) return { field: "from", error: "The start date can't be in the future." };

        const earliest = new Date(`${to}T00:00:00Z`);
        earliest.setUTCFullYear(earliest.getUTCFullYear() - MAX_STATEMENT_YEARS);
        if (from < earliest.toISOString().slice(0, 10)) {
            return { field: "from", error: `A statement can cover up to ${MAX_STATEMENT_YEARS} years.` };
        }
        return { from, to: to > today ? today : to };
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
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

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

    async ownPayment(tenant: CurrentTenant, id: number): Promise<Row | null> {
        if (!Number.isInteger(id) || id < 1) return null;
        return (await RentPayment.query()
            .where("id", id)
            .where("properman_tenant_id", tenant.tenantId)
            .first()) as Row | null;
    }
}
