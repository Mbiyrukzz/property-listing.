// The SMS sign-in shared by the tenant and landlord portals, plus the small
// reply helpers both controllers use. Server-only.
//
// Step 1: account number + phone. HQ issues a code if they match (and the
// reply is the same either way). With Ashmif set up this app texts the code
// itself; otherwise HQ sends it through its own SMS provider.
// Step 2: the code. HQ checks it and returns who signed in; the controller
// then starts that portal's session.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { isConfigured, type PropermanResult } from "./Properman.js";
import { sendSms, smsConfigured } from "./Sms.js";

type Row = Record<string, any>;
type Validation = { valid: boolean; errors?: Record<string, string[]> | null };

export function clientIp(req: TylixRequest): string {
    return String((req as unknown as { ip?: string }).ip ?? "unknown");
}

export function tooMany(res: TylixResponse, message = "Too many attempts. Wait 15 minutes and try again.") {
    res.status(429);
    return res.json({ error: message });
}

export function firstError(data: any): string | null {
    const errors = data?.errors;
    if (errors && typeof errors === "object") {
        const key = Object.keys(errors)[0];
        if (key && Array.isArray(errors[key])) return String(errors[key][0]);
    }
    return typeof data?.error === "string" ? data.error : null;
}

export function unprocessable(res: TylixResponse, errors: Record<string, string[]>) {
    res.status(422);
    return res.json({ errors });
}

// 403 rather than 401: the frontend client answers a 401 by refreshing the
// website-account session, which has nothing to do with portal sessions.
export function signedOut(res: TylixResponse, code: string, message: string) {
    res.status(403);
    return res.json({ error: message, code });
}

// PDFs open in a new tab, so a signed-out visitor goes back to the sign-in.
export function redirectTo(res: TylixResponse, location: string) {
    res.statusCode = 302;
    res.setHeader("Location", location);
    res.setHeader("Cache-Control", "no-store");
    res.end();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(text: string): boolean {
    if (!DATE_RE.test(text)) return false;
    const d = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

// A from..to period for a statement: real dates, in order, not starting in
// the future, at most `maxYears` long; `to` defaults to (and is capped at) today.
export function periodRange(
    fromValue: unknown,
    toValue: unknown,
    today: string,
    maxYears: number,
): { from: string; to: string } | { field: string; error: string } {
    const from = String(fromValue ?? "").trim();
    const to = String(toValue ?? "").trim() || today;
    if (!isRealDate(from)) return { field: "from", error: "Choose a start date." };
    if (!isRealDate(to)) return { field: "to", error: "Choose an end date." };
    if (from > to) return { field: "from", error: "The start date must be before the end date." };
    if (from > today) return { field: "from", error: "The start date can't be in the future." };

    const earliest = new Date(`${to}T00:00:00Z`);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - maxYears);
    if (from < earliest.toISOString().slice(0, 10)) {
        return { field: "from", error: `A statement can cover up to ${maxYears} years.` };
    }
    return { from, to: to > today ? today : to };
}

function accountKey(value: unknown): string {
    return String(value ?? "").trim().toLowerCase().slice(0, 60);
}

function compactPhone(value: unknown): string {
    return String(value ?? "").replace(/[\s-]/g, "");
}

export interface SmsLoginOptions<Who> {
    // Rate limiter names start with this ("tenant" → tenant-login-ip, …).
    name: string;
    validate: (body: Row) => Validation;
    unavailable: (res: TylixResponse, err?: unknown) => unknown;
    start: (accountNumber: string, phone: string, deliverBy: "properman" | "caller") => Promise<PropermanResult>;
    confirm: (accountNumber: string, phone: string, code: string) => Promise<PropermanResult>;
    smsText: (code: string, ttlMinutes: number) => string;
    sentMessage: string;
    // Who signed in, from HQ's confirm reply; null if the reply is unusable.
    identify: (data: Row) => Who | null;
    startSession: (req: TylixRequest, res: TylixResponse, who: Who) => Promise<void>;
}

export function smsLogin<Who>(opts: SmsLoginOptions<Who>) {
    // Sign-in is open to anyone, so it is limited per address and per account.
    const window = 15 * 60_000;
    const loginIp = createRateLimiter({ name: `${opts.name}-login-ip`, max: 10, windowMs: window, store: "shared" });
    const loginAccount = createRateLimiter({ name: `${opts.name}-login-account`, max: 5, windowMs: window, store: "shared" });
    const confirmIp = createRateLimiter({ name: `${opts.name}-confirm-ip`, max: 20, windowMs: window, store: "shared" });
    const confirmAccount = createRateLimiter({ name: `${opts.name}-confirm-account`, max: 10, windowMs: window, store: "shared" });

    return {
        async start(req: TylixRequest, res: TylixResponse) {
            if (!isConfigured()) return opts.unavailable(res);
            if (!(await loginIp(clientIp(req))).allowed) return tooMany(res);

            const result = opts.validate(req.body ?? {});
            if (!result.valid) return unprocessable(res, result.errors ?? {});
            if (!(await loginAccount(accountKey(req.body.account_number))).allowed) return tooMany(res);

            try {
                const ownSms = smsConfigured();
                const reply = await opts.start(
                    String(req.body.account_number).trim(),
                    compactPhone(req.body.phone),
                    ownSms ? "caller" : "properman",
                );
                if (reply.status === 429) return tooMany(res, "Too many attempts. Wait a few minutes and try again.");
                if (!reply.ok) return opts.unavailable(res);

                // `delivery` is only present when the details matched and a
                // fresh code was issued. It never goes back to the browser,
                // so the reply below is the same either way.
                const delivery = reply.data?.delivery;
                if (ownSms && delivery?.code && delivery?.phone) {
                    const ttl = Number(delivery.ttl_minutes) || 10;
                    const sent = await sendSms(String(delivery.phone), opts.smsText(String(delivery.code), ttl));
                    if (!sent) console.error(`[${opts.name}] sign-in SMS was not delivered`);
                }
                return res.json({ sent: true, message: opts.sentMessage });
            } catch (err) {
                return opts.unavailable(res, err);
            }
        },

        async confirm(req: TylixRequest, res: TylixResponse) {
            if (!isConfigured()) return opts.unavailable(res);
            if (!(await confirmIp(clientIp(req))).allowed) return tooMany(res);

            const result = opts.validate(req.body ?? {});
            const code = String(req.body?.code ?? "").trim();
            const codeOk = /^\d{6}$/.test(code);
            if (!result.valid || !codeOk) {
                return unprocessable(res, { ...(result.errors ?? {}), ...(codeOk ? {} : { code: ["Enter the 6-digit code."] }) });
            }
            if (!(await confirmAccount(accountKey(req.body.account_number))).allowed) return tooMany(res);

            try {
                const reply = await opts.confirm(String(req.body.account_number).trim(), compactPhone(req.body.phone), code);
                if (reply.status === 422) {
                    return unprocessable(res, { code: [firstError(reply.data) ?? "That code is wrong or has expired."] });
                }
                const who = reply.ok ? opts.identify(reply.data?.data ?? {}) : null;
                if (!who) return opts.unavailable(res);

                await opts.startSession(req, res, who);
                return res.json({ signedIn: true });
            } catch (err) {
                return opts.unavailable(res, err);
            }
        },
    };
}
