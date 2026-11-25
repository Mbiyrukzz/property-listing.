// Tenant portal sign-in, separate from website accounts.
//
// A tenant signs in with their account number and the phone on file (an SMS
// code proves they hold it). The session is a random token in an HttpOnly
// cookie that only /api/tenant/* receives, with just its SHA-256 stored in
// tenant_sessions (see app/services/PortalSession).

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { TenantSession } from "../models/TenantSession.js";
import { portalSessions } from "./PortalSession.js";

export const TENANT_COOKIE = "bb_tenant";

const sessions = portalSessions({
    cookie: TENANT_COOKIE,
    path: "/api/tenant",
    model: TenantSession,
    idColumn: "properman_tenant_id",
    nameColumn: "tenant_name",
});

export interface TenantIdentity {
    tenantId: number;
    name: string;
    accountNumber: string;
    phone: string;
}

export interface CurrentTenant extends TenantIdentity {
    sessionId: number;
}

export async function startTenantSession(req: TylixRequest, res: TylixResponse, tenant: TenantIdentity): Promise<void> {
    await sessions.start(req, res, { id: tenant.tenantId, name: tenant.name, accountNumber: tenant.accountNumber, phone: tenant.phone });
}

// The signed-in tenant, or null. Expired and idle sessions are deleted here.
export async function currentTenant(req: TylixRequest): Promise<CurrentTenant | null> {
    const s = await sessions.current(req);
    return s ? { sessionId: s.sessionId, tenantId: s.id, name: s.name, accountNumber: s.accountNumber, phone: s.phone } : null;
}

export async function endTenantSession(req: TylixRequest, res: TylixResponse): Promise<void> {
    await sessions.end(req, res);
}

export async function pruneTenantSessions(): Promise<number> {
    return sessions.prune();
}
