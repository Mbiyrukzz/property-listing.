// One landlord payout as a PDF, from HQ's payout detail
// (GET /landlords/{id}/payouts/{payout}): what was collected on the
// property, what was deducted, what was paid, and each unit's collections.

import { createPdf } from "@tylix/pdf";
import type { Content } from "@tylix/pdf";
import { COLORS, facts, fill, footerFor, header, kes, letterhead, longDate, money, sectionTitle } from "./shared.js";

type Row = Record<string, any>;

export const PAYOUT_STATUS: Record<string, { label: string; color: string }> = {
    paid: { label: "PAID", color: COLORS.mint },
    processing: { label: "PROCESSING", color: COLORS.brand },
    failed: { label: "PAYOUT FAILED", color: COLORS.coral },
};

// The lines between "collected" and "net payout", in the order HQ applies
// them. Zero lines are left out, except the fee when a rate is set.
export function breakdownLines(b: Row): Array<{ label: string; amount: number; strong?: boolean }> {
    const n = (v: unknown) => Number(v) || 0;
    const lines: Array<{ label: string; amount: number; strong?: boolean }> = [
        { label: "Rent collected", amount: n(b.collected) },
    ];
    if (n(b.credit_notes)) lines.push({ label: "Credit notes", amount: n(b.credit_notes) });
    if (n(b.management_fee) || n(b.management_fee_percent)) {
        const rate = n(b.management_fee_percent);
        lines.push({ label: rate ? `Management fee (${rate}%)` : "Management fee", amount: -n(b.management_fee) });
    }
    if (n(b.expenses)) lines.push({ label: "Property expenses", amount: -n(b.expenses) });
    if (n(b.loan_repayment)) lines.push({ label: String(b.loan_description || "Loan repayment"), amount: -n(b.loan_repayment) });
    if (n(b.other)) lines.push({ label: n(b.other) > 0 ? "Deposits, utilities & other credits" : "Other deductions", amount: n(b.other) });
    lines.push({ label: "Net payout", amount: n(b.net_payout), strong: true });
    return lines;
}

function signed(value: number): string {
    if (Math.abs(value) < 0.005) return "0.00";
    const text = Math.abs(value).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return value < 0 ? `− ${text}` : text;
}

export function payoutPdf(payout: Row, settings: Record<string, string>) {
    const from = letterhead(payout.issuer, settings);
    const landlord = payout.landlord ?? {};
    const b = payout.breakdown ?? {};
    const status = PAYOUT_STATUS[String(payout.status)] ?? PAYOUT_STATUS.processing;
    const units: Row[] = Array.isArray(payout.units) ? payout.units : [];
    const expenses: Row[] = Array.isArray(payout.expenses) ? payout.expenses : [];
    const credits: Row[] = Array.isArray(payout.credit_notes) ? payout.credit_notes : [];
    const paid = Number(b.paid ?? payout.paid) || 0;
    const heldBack = Number(b.held_back) || 0;
    const period = payout.period_start && payout.period_end
        ? `${longDate(payout.period_start)} – ${longDate(payout.period_end)}`
        : String(payout.period ?? "");

    const content: Content[] = [
        header(from, "PAYOUT", `${payout.property?.name ?? ""} · ${payout.period ?? ""}`),
        {
            columns: [
                fill({
                    stack: [
                        sectionTitle("Paid to"),
                        { text: String(landlord.name ?? ""), bold: true, size: 11 },
                        facts([
                            ["Account no.", String(landlord.account_number ?? "")],
                            ["Phone", String(landlord.phone ?? "")],
                            ["Email", String(landlord.email ?? "")],
                        ]),
                    ],
                }),
                {
                    width: 220,
                    stack: [
                        sectionTitle("Payout"),
                        facts([
                            ["Property", String(payout.property?.name ?? "")],
                            ["Collection period", period],
                            ["Paid on", longDate(payout.paid_at)],
                            ["Reference", `PAYOUT-${payout.id}`],
                        ]),
                        {
                            text: status.label,
                            bold: true,
                            size: 9,
                            color: status.color,
                            border: { width: 1, color: status.color },
                            radius: 3,
                            padding: [3, 8],
                            align: "center",
                            width: 110,
                            margin: [6, 0, 0, 0],
                        },
                    ],
                },
            ],
            gap: 24,
            margin: [0, 0, 20, 0],
        },
        sectionTitle("How this payout was worked out"),
        {
            table: {
                columns: [
                    { header: "", width: "*", value: (r: Row) => ({ text: r.label, bold: Boolean(r.strong) }) },
                    { header: "KES", width: 110, align: "right", value: (r: Row) => ({ text: signed(r.amount), bold: Boolean(r.strong) }) },
                ],
                rows: breakdownLines(b),
                borders: "horizontal",
                borderColor: COLORS.line,
                headerStyle: { bold: true, size: 8.5, color: COLORS.muted, background: COLORS.wash },
                fontSize: 9.5,
                padding: [5, 6],
            },
        },
        {
            columns: [
                { text: heldBack > 0 ? "Paid to you (part payment)" : "Paid to you", bold: true },
                { text: kes(paid), bold: true, align: "right", color: COLORS.mint },
            ],
            background: COLORS.wash,
            padding: [8, 8],
            radius: 4,
            margin: [8, 0, 0, 0],
        },
    ];

    if (heldBack > 0) {
        content.push({
            text: `${kes(heldBack)} of the net payout was not paid out in this payment. It stays on your account with the office.`,
            size: 8.5,
            color: COLORS.muted,
            margin: [6, 0, 0, 0],
        });
    }

    const itemTable = (title: string, rows: Row[]): Content[] => rows.length === 0 ? [] : [
        sectionTitle(title, 18),
        {
            table: {
                columns: [
                    { header: "Description", width: "*", value: (r: Row) => String(r.description ?? "") },
                    { header: "KES", width: 110, align: "right", value: (r: Row) => money(r.amount) },
                ],
                rows,
                borders: "horizontal",
                borderColor: COLORS.line,
                headerStyle: { bold: true, size: 8.5, color: COLORS.muted, background: COLORS.wash },
                fontSize: 9,
                padding: [4, 6],
            },
        },
    ];
    content.push(...itemTable("Expenses deducted", expenses), ...itemTable("Credit notes", credits));

    if (units.length > 0) {
        content.push(
            sectionTitle("Collections by unit", 18),
            {
                table: {
                    columns: [
                        { header: "Unit", width: 90, value: (r: Row) => String(r.name ?? "") },
                        { header: "Tenant", width: "*", value: (r: Row) => ({ text: String(r.tenant ?? ""), color: r.tenant === "Vacant" ? COLORS.muted : COLORS.ink }) },
                        { header: "Rent", width: 72, align: "right", value: (r: Row) => money(r.rent) },
                        { header: "Collected", width: 72, align: "right", value: (r: Row) => money(r.payments) },
                        { header: "Owing", width: 72, align: "right", value: (r: Row) => ({ text: money(r.balance), color: Number(r.balance) > 0 ? COLORS.coral : COLORS.ink }) },
                    ],
                    rows: units,
                    footer: [[
                        { content: { text: "Total", bold: true }, colSpan: 2 },
                        { content: { text: money(units.reduce((s, u) => s + (Number(u.rent) || 0), 0)), bold: true }, align: "right" },
                        { content: { text: money(units.reduce((s, u) => s + (Number(u.payments) || 0), 0)), bold: true }, align: "right" },
                        { content: { text: money(units.reduce((s, u) => s + (Number(u.balance) || 0), 0)), bold: true }, align: "right" },
                    ]],
                    borders: "horizontal",
                    borderColor: COLORS.line,
                    headerStyle: { bold: true, size: 8.5, color: COLORS.muted, background: COLORS.wash },
                    footerStyle: { background: COLORS.wash },
                    fontSize: 9,
                    padding: [4, 6],
                    dontBreakRows: true,
                },
            },
        );
    }

    if (payout.notes) {
        content.push({ text: [{ text: "Note from the office: ", bold: true }, String(payout.notes)], size: 9, margin: [14, 0, 0, 0] });
    }

    content.push({
        text: "All amounts in KES. Unit figures are as recorded when the payout was prepared.",
        size: 8.5,
        color: COLORS.muted,
        margin: [10, 0, 0, 0],
    });

    return createPdf({
        title: `Payout ${payout.property?.name ?? ""} ${payout.period ?? ""}`.trim(),
        author: from.name,
        subject: `Payout statement for ${landlord.name ?? "landlord"}`,
        size: "A4",
        margins: [48, 44, 56, 44],
        defaultStyle: { font: "Helvetica", size: 10, color: COLORS.ink, lineHeight: 1.3 },
        footer: footerFor(settings.site_name || from.name, "landlord portal"),
        content,
    });
}
