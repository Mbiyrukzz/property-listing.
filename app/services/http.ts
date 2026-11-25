import type { TylixRequest } from "@tylix/core";

// The client's address. Tylix sets req.ip at runtime (honouring
// TRUST_PROXY), but TylixRequest's type doesn't declare it yet.
export function clientIp(req: TylixRequest): string {
    return String((req as unknown as { ip?: string }).ip ?? req.socket?.remoteAddress ?? "unknown");
}
