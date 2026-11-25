// Tenant portal sign-in, separate from website accounts.
//
// A tenant signs in with their account number and the phone on file (an SMS
// code proves they hold it). That starts a tenant session: a random token in
// an HttpOnly cookie that only /api/tenant/* receives, with just its SHA-256
// stored in tenant_sessions. It never becomes a `users` row or a
// req.user, so it can't reach anything outside the tenant API.

import { randomToken, sha256Hex } from "@tylix/auth";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { TenantSession } from "../models/TenantSession.js";

type Row = Record<string, any>;

export const TENANT_COOKIE = "bb_tenant";
const COOKIE_PATH = "/api/tenant";

// Signed in for up to 30 days, but a week without a visit ends it.
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
// last_used_at is written at most this often, not on every request.
const TOUCH_EVERY_MS = 5 * 60_000;

export interface TenantIdentity {
    tenantId: number;
    name: string;
    accountNumber: string;
    phone: string;
}

export interface CurrentTenant extends TenantIdentity {
    sessionId: number;
}

function timeOf(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    const t = Date.parse(String(value ?? ""));
    return Number.isFinite(t) ? t : 0;
}

function clientIp(req: TylixRequest): string {
    return String((req as unknown as { ip?: string }).ip ?? "").slice(0, 64);
}

function setCookie(res: TylixResponse, token: string) {
    res.cookie(TENANT_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: COOKIE_PATH,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
}

function clearCookie(res: TylixResponse) {
    res.clearCookie(TENANT_COOKIE, { httpOnly: true, sameSite: "Lax", path: COOKIE_PATH });
}

export async function startTenantSession(req: TylixRequest, res: TylixResponse, tenant: TenantIdentity): Promise<void> {
    // A sign-in replaces whatever session this browser had (the new cookie
    // overwrites the old one).
    const previous = await sessionRow(req);
    if (previous) await TenantSession.delete(previous.id);

    const token = randomToken(32);
    const now = Date.now();
    await TenantSession.create({
        token_hash: await sha256Hex(token),
        properman_tenant_id: tenant.tenantId,
        tenant_name: tenant.name.slice(0, 160),
        account_number: tenant.accountNumber.slice(0, 60),
        phone: tenant.phone.slice(0, 40),
        ip: clientIp(req),
        user_agent: String(req.headers["user-agent"] ?? "").slice(0, 255),
        last_used_at: new Date(now).toISOString(),
        expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    setCookie(res, token);
}

async function sessionRow(req: TylixRequest): Promise<Row | null> {
    const token = String(req.cookies?.[TENANT_COOKIE] ?? "");
    if (!token || token.length > 128) return null;
    return (await TenantSession.query().where("token_hash", await sha256Hex(token)).first()) as Row | null;
}

// The signed-in tenant, or null. Expired and idle sessions are deleted here.
export async function currentTenant(req: TylixRequest): Promise<CurrentTenant | null> {
    const row = await sessionRow(req);
    if (!row) return null;

    const now = Date.now();
    const lastUsed = timeOf(row.last_used_at) || timeOf(row.created_at);
    if (timeOf(row.expires_at) <= now || lastUsed + IDLE_TIMEOUT_MS <= now) {
        await TenantSession.delete(row.id);
        return null;
    }
    if (now - lastUsed > TOUCH_EVERY_MS) {
        await TenantSession.update(row.id, { last_used_at: new Date(now).toISOString() });
    }

    return {
        sessionId: Number(row.id),
        tenantId: Number(row.properman_tenant_id),
        name: String(row.tenant_name ?? ""),
        accountNumber: String(row.account_number ?? ""),
        phone: String(row.phone ?? ""),
    };
}

export async function endTenantSession(req: TylixRequest, res: TylixResponse): Promise<void> {
    const row = await sessionRow(req);
    if (row) await TenantSession.delete(row.id);
    clearCookie(res);
}

// Run by the scheduler: rows for browsers that never came back.
export async function pruneTenantSessions(): Promise<number> {
    const cutoff = Date.now();
    // Stalest first, so the ones that have run out are always in this batch.
    const rows = (await TenantSession.query().orderBy("last_used_at").limit(1000).get()) as Row[];
    let removed = 0;
    for (const row of rows) {
        const lastUsed = timeOf(row.last_used_at) || timeOf(row.created_at);
        if (timeOf(row.expires_at) <= cutoff || lastUsed + IDLE_TIMEOUT_MS <= cutoff) {
            await TenantSession.delete(row.id);
            removed++;
        }
    }
    return removed;
}
