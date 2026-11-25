// HTTP client for Properman's /api/bbhomes/v1 API (see the Properman repo:
// routes/bbhomes.php). Server-only.
//
// Every call returns { ok, status, data } and only throws PropermanError when
// Properman can't be reached at all (network error, timeout, not configured).

import crypto from "node:crypto";

export class PropermanError extends Error {
    constructor(message: string, readonly status = 0) {
        super(message);
        this.name = "PropermanError";
    }
}

export interface PropermanResult<T = any> {
    ok: boolean;
    status: number;
    data: T;
}

export interface PropermanUnit {
    id: number;
    slug: string | null;
    name: string;
    type: string;
    bedrooms: number;
    bathrooms: number;
    rent: number;
    vacant: boolean;
    images: string[];
}

export interface PropermanProperty {
    id: number;
    name: string;
    slug: string;
    location: string;
    category: string;
    description: string;
    images: string[];
    published_at: string | null;
    updated_at: string | null;
    units: PropermanUnit[];
}

function baseUrl(): string {
    return String(process.env.HQ_URL ?? "").trim().replace(/\/+$/, "");
}

// Properman builds photo URLs from the request it is answering, so behind a
// proxy they can come back as http://hq... or as a bare /storage/... path.
// The site only loads https images (CSP), so put them on HQ_URL's
// scheme and host. URLs on other hosts (a CDN, S3) are left alone.
export function absoluteMediaUrl(value: unknown): unknown {
    const text = String(value ?? "").trim();
    const base = baseUrl();
    if (!text || !base) return value;
    try {
        const root = new URL(base);
        if (text.startsWith("/") && !text.startsWith("//")) return root.origin + text;
        const url = new URL(text);
        if (url.hostname === root.hostname && url.protocol !== root.protocol) {
            url.protocol = root.protocol;
            url.port = root.port;
            return url.toString();
        }
    } catch {
        return value;
    }
    return value;
}

export function isConfigured(): boolean {
    return baseUrl() !== "" && String(process.env.HQ_API_TOKEN ?? "").trim() !== "";
}

export function webhookSecret(): string {
    return String(process.env.HQ_WEBHOOK_SECRET ?? "").trim();
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<PropermanResult<T>> {
    if (!isConfigured()) {
        throw new PropermanError("Properman is not configured (HQ_URL / HQ_API_TOKEN).");
    }

    let response: Response;
    try {
        response = await fetch(`${baseUrl()}/api/bbhomes/v1${path}`, {
            method,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${String(process.env.HQ_API_TOKEN).trim()}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
        });
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new PropermanError(`Properman could not be reached: ${reason}`);
    }

    let data: any = null;
    const text = await response.text();
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { error: text.slice(0, 300) };
        }
    }

    if (response.status === 401 || response.status === 503) {
        // A wrong token or a switched-off integration is a setup problem, not
        // a per-record one: surface it loudly.
        throw new PropermanError(
            `HQ refused the request (${response.status}): ${data?.error ?? "check HQ_API_TOKEN"}`,
            response.status,
        );
    }

    return { ok: response.ok, status: response.status, data };
}

export const Properman = {
    listProperties: () => call<{ data: PropermanProperty[] }>("GET", "/properties"),
    getProperty: (id: number) => call<{ data: PropermanProperty }>("GET", `/properties/${id}`),

    // deliverBy "caller": Properman returns the code (in `delivery`) for this
    // app to send by its own SMS gateway, instead of texting it itself.
    startTenantVerification: (accountNumber: string, phone: string, deliverBy: "properman" | "caller" = "properman") =>
        call("POST", "/tenants/verification", { account_number: accountNumber, phone, deliver_by: deliverBy }),
    confirmTenantVerification: (accountNumber: string, phone: string, code: string) =>
        call("POST", "/tenants/verification/confirm", { account_number: accountNumber, phone, code }),

    tenantSummary: (tenantId: number) => call("GET", `/tenants/${tenantId}/summary`),
    tenantInvoices: (tenantId: number) => call("GET", `/tenants/${tenantId}/invoices?limit=24`),
    tenantPayments: (tenantId: number) => call("GET", `/tenants/${tenantId}/payments?limit=50`),
    // One invoice with its items and payments, for the invoice PDF.
    tenantInvoice: (tenantId: number, invoiceId: number) => call("GET", `/tenants/${tenantId}/invoices/${invoiceId}`),
    // A ledger for from..to (YYYY-MM-DD), for the statement PDF.
    tenantStatement: (tenantId: number, from: string, to: string) =>
        call("GET", `/tenants/${tenantId}/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    stkPush: (tenantId: number, phone: string, amount: number) =>
        call("POST", `/tenants/${tenantId}/stk-push`, { phone, amount }),
    paymentStatus: (tenantId: number, paymentId: number) =>
        call("GET", `/tenants/${tenantId}/payments/${paymentId}/status`),
};

// Webhook signature: hex HMAC-SHA256 of "<timestamp>.<raw body>" (see
// Properman app/Jobs/Bbhomes/NotifyBbhomes). Refuses anything older or
// newer than five minutes, so a captured request can't be replayed later.
export function verifyWebhookSignature(
    rawBody: string,
    timestamp: unknown,
    signature: unknown,
    nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
    const secret = webhookSecret();
    if (!secret) return false;

    const ts = Number(timestamp);
    if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > 300) return false;

    const given = String(signature ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(given)) return false;

    const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
}
