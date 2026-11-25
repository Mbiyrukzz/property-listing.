// Tenant portal: link a Barani Better Homes account to a Properman tenancy (SMS code to
// the phone on file), then read balances, invoices and receipts and pay rent
// by M-Pesa.
//
// Properman stays the record for rent: balances and receipts are read from it
// on each visit, and payments go through Properman's own STK flow, which
// applies the money and sends the receipt SMS. Barani Better Homes keeps only a
// rent_payments row so the tenant can follow the request.
//
// The tenant id sent to Properman always comes from this user's own
// tenant_links row, never from the request.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { TenantLink } from "../models/TenantLink.js";
import { RentPayment } from "../models/RentPayment.js";
import { Properman, isConfigured } from "../services/Properman.js";
import { validatePayment, validateTenantLink } from "../validators/ListingValidators.js";

type Row = Record<string, any>;

const linkLimiter = createRateLimiter({ name: "tenant-link", max: 5, windowMs: 15 * 60_000, store: "shared" });
const confirmLimiter = createRateLimiter({ name: "tenant-link-confirm", max: 10, windowMs: 15 * 60_000, store: "shared" });
const payLimiter = createRateLimiter({ name: "tenant-pay", max: 5, windowMs: 10 * 60_000, store: "shared" });

function uid(req: TylixRequest): number {
    return Number(req.user?.userId);
}

async function linkOf(userId: number): Promise<Row | null> {
    return (await TenantLink.query().where("user_id", userId).first()) as Row | null;
}

function unavailable(res: TylixResponse, err?: unknown) {
    if (err) console.error("[tenant] HQ call failed:", err instanceof Error ? err.message : err);
    res.status(503);
    return res.json({ error: "The tenant portal can't reach the rent system right now. Please try again shortly." });
}

function firstError(data: any): string | null {
    const errors = data?.errors;
    if (errors && typeof errors === "object") {
        const key = Object.keys(errors)[0];
        if (key && Array.isArray(errors[key])) return String(errors[key][0]);
    }
    return typeof data?.error === "string" ? data.error : null;
}

export class TenantController {
    async status(req: TylixRequest, res: TylixResponse) {
        const link = await linkOf(uid(req));
        if (!isConfigured()) return res.json({ enabled: false, linked: Boolean(link) });
        if (!link) return res.json({ enabled: true, linked: false });

        try {
            const summary = await Properman.tenantSummary(Number(link.properman_tenant_id));
            if (summary.status === 404) {
                // The tenancy is gone in Properman (moved out and removed).
                return res.json({ enabled: true, linked: true, stale: true, name: link.tenant_name });
            }
            if (!summary.ok) return unavailable(res);
            return res.json({ enabled: true, linked: true, summary: summary.data.data });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async startLink(req: TylixRequest, res: TylixResponse) {
        if (!isConfigured()) return unavailable(res);
        if (!(await linkLimiter(`u:${uid(req)}`)).allowed) {
            res.status(429);
            return res.json({ error: "Too many attempts. Wait 15 minutes and try again." });
        }

        const result = validateTenantLink(req.body ?? {});
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        try {
            const reply = await Properman.startTenantVerification(
                String(req.body.account_number).trim(),
                String(req.body.phone).replace(/[\s-]/g, ""),
            );
            if (reply.status === 429) {
                res.status(429);
                return res.json({ error: "Too many attempts. Wait a few minutes and try again." });
            }
            if (!reply.ok) return unavailable(res);
            return res.json({
                sent: true,
                message: "If those details match your tenancy, we've sent a 6-digit code by SMS to the phone your landlord has on file.",
            });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async confirmLink(req: TylixRequest, res: TylixResponse) {
        if (!isConfigured()) return unavailable(res);
        const userId = uid(req);
        if (!(await confirmLimiter(`u:${userId}`)).allowed) {
            res.status(429);
            return res.json({ error: "Too many attempts. Wait 15 minutes and try again." });
        }

        const result = validateTenantLink(req.body ?? {});
        const code = String(req.body?.code ?? "").trim();
        if (!result.valid || !/^\d{6}$/.test(code)) {
            res.status(422);
            return res.json({ errors: { ...(result.errors ?? {}), ...(/^\d{6}$/.test(code) ? {} : { code: ["Enter the 6-digit code."] }) } });
        }

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
            await TenantLink.updateOrCreate(
                { user_id: userId },
                {
                    user_id: userId,
                    properman_tenant_id: Number(t.tenant_id),
                    tenant_name: String(t.name ?? "").slice(0, 160),
                    account_number: String(t.account_number ?? "").slice(0, 60),
                    phone: String(t.phone ?? "").slice(0, 40),
                    verified_at: new Date().toISOString(),
                },
            );
            return res.json({ linked: true });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async unlink(req: TylixRequest, res: TylixResponse) {
        const link = await linkOf(uid(req));
        if (link) await TenantLink.delete(link.id);
        return res.json({ linked: false });
    }

    async invoices(req: TylixRequest, res: TylixResponse) {
        const link = await linkOf(uid(req));
        if (!link) {
            res.status(404);
            return res.json({ error: "Link your tenancy first." });
        }
        try {
            const reply = await Properman.tenantInvoices(Number(link.properman_tenant_id));
            if (!reply.ok) return unavailable(res);
            return res.json({ data: reply.data.data ?? [] });
        } catch (err) {
            return unavailable(res, err);
        }
    }

    async payments(req: TylixRequest, res: TylixResponse) {
        const userId = uid(req);
        const link = await linkOf(userId);
        if (!link) {
            res.status(404);
            return res.json({ error: "Link your tenancy first." });
        }
        try {
            const reply = await Properman.tenantPayments(Number(link.properman_tenant_id));
            if (!reply.ok) return unavailable(res);
            const requests = (await RentPayment.query()
                .where("user_id", userId)
                .where("properman_tenant_id", Number(link.properman_tenant_id))
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
        const userId = uid(req);
        const link = await linkOf(userId);
        if (!link) {
            res.status(404);
            return res.json({ error: "Link your tenancy first." });
        }
        if (!(await payLimiter(`u:${userId}`)).allowed) {
            res.status(429);
            return res.json({ error: "Several payment requests were sent recently. Wait a few minutes." });
        }

        const result = validatePayment(req.body ?? {});
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const phone = String(req.body.phone).replace(/[\s-]/g, "");
        const amount = Math.round(Number(req.body.amount));
        const tenantId = Number(link.properman_tenant_id);

        try {
            const reply = await Properman.stkPush(tenantId, phone, amount);
            const paymentId = Number(reply.data?.data?.payment_id ?? reply.data?.payment_id) || null;
            const accepted = reply.status === 201;

            const row = (await RentPayment.create({
                user_id: userId,
                properman_tenant_id: tenantId,
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
        const userId = uid(req);
        const row = (await RentPayment.query().where("id", Number(req.params.id)).where("user_id", userId).first()) as Row | null;
        if (!row) {
            res.status(404);
            return res.json({ error: "Payment not found." });
        }

        if (row.status === "pending" && row.properman_payment_id) {
            try {
                const reply = await Properman.paymentStatus(Number(row.properman_tenant_id), Number(row.properman_payment_id));
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
}
