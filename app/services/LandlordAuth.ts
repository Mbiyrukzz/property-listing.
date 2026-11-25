// Landlord portal sign-in: the same protocol as tenants (account number +
// the phone HQ has on file, proved by an SMS code), with its own cookie that
// only /api/landlord/* receives and its own table, landlord_sessions.
// See app/services/PortalSession.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { LandlordSession } from "../models/LandlordSession.js";
import { portalSessions } from "./PortalSession.js";

export const LANDLORD_COOKIE = "bb_landlord";

const sessions = portalSessions({
    cookie: LANDLORD_COOKIE,
    path: "/api/landlord",
    model: LandlordSession,
    idColumn: "properman_landlord_id",
    nameColumn: "landlord_name",
});

export interface LandlordIdentity {
    landlordId: number;
    name: string;
    accountNumber: string;
    phone: string;
}

export interface CurrentLandlord extends LandlordIdentity {
    sessionId: number;
}

export async function startLandlordSession(req: TylixRequest, res: TylixResponse, landlord: LandlordIdentity): Promise<void> {
    await sessions.start(req, res, { id: landlord.landlordId, name: landlord.name, accountNumber: landlord.accountNumber, phone: landlord.phone });
}

export async function currentLandlord(req: TylixRequest): Promise<CurrentLandlord | null> {
    const s = await sessions.current(req);
    return s ? { sessionId: s.sessionId, landlordId: s.id, name: s.name, accountNumber: s.accountNumber, phone: s.phone } : null;
}

export async function endLandlordSession(req: TylixRequest, res: TylixResponse): Promise<void> {
    await sessions.end(req, res);
}

export async function pruneLandlordSessions(): Promise<number> {
    return sessions.prune();
}
