// Shared look for tenant documents (invoices, statements) drawn with
// @tylix/pdf. Server-only.

import fs from "node:fs";
import path from "node:path";
import type { Content } from "@tylix/pdf";

type Row = Record<string, any>;

export const COLORS = {
    ink: "#111827",
    muted: "#647082",
    brand: "#0E63B8",
    mint: "#15804E",
    coral: "#CD2D42",
    line: "#E4E8EF",
    wash: "#F4F6FA",
};

const LOGO_PATH = path.join(process.cwd(), "public", "barani-logo.png");

export interface Letterhead {
    name: string;
    address: string;
    phone: string;
    email: string;
}

// Properman's company details, with the site's own contact settings for
// anything Properman leaves blank.
export function letterhead(issuer: Row | null | undefined, settings: Record<string, string>): Letterhead {
    const pick = (a: unknown, b: unknown) => String(a ?? "").trim() || String(b ?? "").trim();
    return {
        name: pick(issuer?.name, settings.site_name) || "Barani Better Homes",
        address: pick(issuer?.address, settings.address),
        phone: pick(issuer?.phone, settings.phone || settings.whatsapp),
        email: pick(issuer?.email, settings.email),
    };
}

export function kes(value: unknown): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return "KES —";
    const text = Math.abs(n).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? `-KES ${text}` : `KES ${text}`;
}

// Amounts in table cells, where the column header already says KES.
export function money(value: unknown): string {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return "";
    return n.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "4 Sep 2026". Plain dates are taken as they are; date-times are shown
// on their Kenyan calendar day, whatever the server's time zone.
export function longDate(value: unknown): string {
    let text = String(value ?? "").trim();
    if (!text) return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const d = new Date(text);
        if (Number.isNaN(d.getTime())) return "";
        text = d.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    }
    const [y, m, day] = text.split("-").map(Number);
    if (!y || !m || !day || m > 12) return "";
    return `${day} ${MONTHS[m - 1]} ${y}`;
}

export function todayIso(): string {
    // YYYY-MM-DD in Kenyan time.
    return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

// Properman invoice_type values (constants on its Transaction model).
export function invoiceTypeLabel(type: unknown): string {
    switch (String(type ?? "")) {
        case "income": return "Rent";
        case "income_deposit": return "Deposit";
        case "income_shared_utility": return "Utilities";
        case "income_lockfee":
        case "lock_fee": return "Late fee";
        case "income_agentfee": return "Agent fee";
        default: return "Invoice";
    }
}

// A column that takes the width the others leave ("*") or just what it needs
// ("auto"). @tylix/pdf draws both on a column child, but its types
// (BlockProps.width) only allow lengths there.
export function fill(node: Record<string, unknown>, width: "*" | "auto" = "*"): Content {
    return { ...node, width } as unknown as Content;
}

export function header(from: Letterhead, title: string, subtitle: string): Content {
    const contact = [from.address, from.phone, from.email].filter(Boolean);
    return [
        {
            columns: [
                fs.existsSync(LOGO_PATH) ? { image: LOGO_PATH, width: 54 } : { text: "", width: 0 },
                fill({
                    stack: [
                        { text: from.name, bold: true, size: 13, color: COLORS.ink },
                        ...contact.map((line) => ({ text: line, size: 9, color: COLORS.muted })),
                    ],
                    gap: 1,
                }),
                fill({
                    stack: [
                        { text: title, bold: true, size: 20, color: COLORS.brand, align: "right" },
                        { text: subtitle, size: 9, color: COLORS.muted, align: "right" },
                    ],
                }, "auto"),
            ],
            gap: 12,
            valign: "middle",
        },
        { hr: { color: COLORS.line, thickness: 1 }, margin: [14, 0, 16, 0] },
    ];
}

// "Label  value" pairs as a borderless two-column table.
export function facts(rows: Array<[string, string]>): Content {
    return {
        table: {
            columns: [
                { key: "0", width: "auto", style: { color: COLORS.muted } },
                { key: "1", width: "*", style: { bold: true } },
            ],
            rows: rows.filter(([, v]) => v).map(([k, v]) => ({ 0: k, 1: v })),
            borders: "none",
            padding: [2, 10, 2, 0],
            fontSize: 9.5,
            emptyText: false,
        },
    };
}

export function sectionTitle(text: string): Content {
    return { text: text.toUpperCase(), bold: true, size: 8.5, color: COLORS.muted, characterSpacing: 0.6, margin: [0, 0, 6, 0] };
}

export function footerFor(siteName: string) {
    return {
        columns: [
            { text: `${siteName} · tenant portal · generated ${longDate(todayIso())}`, size: 8, color: COLORS.muted },
            { text: "Page {page} of {pages}", size: 8, color: COLORS.muted, align: "right" as const, width: "auto" },
        ],
        margin: [0, 0, 0, 0],
    } as Content;
}

// Safe for a Content-Disposition filename.
export function fileSafe(value: unknown): string {
    return String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";
}
