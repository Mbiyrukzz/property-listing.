// Sessions for the SMS sign-in portals (tenants at /tenant, landlords at
// /landlord), separate from website accounts.
//
// Someone signs in with an account number and the phone HQ has on file (an
// SMS code proves they hold it). That starts a portal session: a random
// token in an HttpOnly cookie that only that portal's API path receives,
// with just its SHA-256 stored. It never becomes a `users` row or a
// req.user, so it can't reach anything outside that portal's API, and a
// tenant cookie is never sent to the landlord API or the other way round.

import { randomToken, sha256Hex } from "@tylix/auth";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import type { Model } from "@tylix/orm";

type Row = Record<string, any>;

// Signed in for up to 30 days, but a week without a visit ends it.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
// last_used_at is written at most this often, not on every request.
const TOUCH_EVERY_MS = 5 * 60_000;

export interface PortalIdentity {
    // HQ's id for the tenant or landlord.
    id: number;
    name: string;
    accountNumber: string;
    phone: string;
}

export interface PortalSessionRow extends PortalIdentity {
    sessionId: number;
}

export interface PortalSessionOptions {
    cookie: string;
    // Only requests under this path carry the cookie.
    path: string;
    model: typeof Model;
    // Columns holding HQ's id and the display name.
    idColumn: string;
    nameColumn: string;
}

function timeOf(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    const t = Date.parse(String(value ?? ""));
    return Number.isFinite(t) ? t : 0;
}

function clientIp(req: TylixRequest): string {
    return String((req as unknown as { ip?: string }).ip ?? "").slice(0, 64);
}

function isStale(row: Row, now: number): boolean {
    const lastUsed = timeOf(row.last_used_at) || timeOf(row.created_at);
    return timeOf(row.expires_at) <= now || lastUsed + IDLE_TIMEOUT_MS <= now;
}

export function portalSessions(opts: PortalSessionOptions) {
    const { cookie, path, model, idColumn, nameColumn } = opts;

    function setCookie(res: TylixResponse, token: string) {
        res.cookie(cookie, token, { httpOnly: true, sameSite: "Lax", path, maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    }

    function clearCookie(res: TylixResponse) {
        res.clearCookie(cookie, { httpOnly: true, sameSite: "Lax", path });
    }

    async function sessionRow(req: TylixRequest): Promise<Row | null> {
        const token = String(req.cookies?.[cookie] ?? "");
        if (!token || token.length > 128) return null;
        return (await model.query().where("token_hash", await sha256Hex(token)).first()) as Row | null;
    }

    return {
        cookie,

        async start(req: TylixRequest, res: TylixResponse, who: PortalIdentity): Promise<void> {
            // A sign-in replaces whatever session this browser had (the new
            // cookie overwrites the old one).
            const previous = await sessionRow(req);
            if (previous) await model.delete(previous.id);

            const token = randomToken(32);
            const now = Date.now();
            await model.create({
                token_hash: await sha256Hex(token),
                [idColumn]: who.id,
                [nameColumn]: who.name.slice(0, 160),
                account_number: who.accountNumber.slice(0, 60),
                phone: who.phone.slice(0, 40),
                ip: clientIp(req),
                user_agent: String(req.headers["user-agent"] ?? "").slice(0, 255),
                last_used_at: new Date(now).toISOString(),
                expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
            });
            setCookie(res, token);
        },

        // The signed-in identity, or null. Expired and idle sessions are deleted here.
        async current(req: TylixRequest): Promise<PortalSessionRow | null> {
            const row = await sessionRow(req);
            if (!row) return null;

            const now = Date.now();
            if (isStale(row, now)) {
                await model.delete(row.id);
                return null;
            }
            const lastUsed = timeOf(row.last_used_at) || timeOf(row.created_at);
            if (now - lastUsed > TOUCH_EVERY_MS) {
                await model.update(row.id, { last_used_at: new Date(now).toISOString() });
            }

            return {
                sessionId: Number(row.id),
                id: Number(row[idColumn]),
                name: String(row[nameColumn] ?? ""),
                accountNumber: String(row.account_number ?? ""),
                phone: String(row.phone ?? ""),
            };
        },

        async end(req: TylixRequest, res: TylixResponse): Promise<void> {
            const row = await sessionRow(req);
            if (row) await model.delete(row.id);
            clearCookie(res);
        },

        // Run by the scheduler: rows for browsers that never came back.
        async prune(): Promise<number> {
            const now = Date.now();
            // Stalest first, so the ones that have run out are always in this batch.
            const rows = (await model.query().orderBy("last_used_at").limit(1000).get()) as Row[];
            let removed = 0;
            for (const row of rows) {
                if (isStale(row, now)) {
                    await model.delete(row.id);
                    removed++;
                }
            }
            return removed;
        },
    };
}
