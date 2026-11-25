// A landlord's income statement for a period, as a PDF, from HQ
// (GET /landlords/{id}/statement?from=&to=): every payout made in the
// period with what was collected, deducted and paid, and totals.

import { createPdf } from "@tylix/pdf";
import type { Content } from "@tylix/pdf";
import { COLORS, facts, fill, footerFor, header, kes, letterhead, longDate, money, sectionTitle } from "./shared.js";

type Row = Record<string, any>;

const n = (v: unknown) => Number(v) || 0;

// Fee + expenses + loan: everything taken off the collections.
function deductions(r: Row): number {
    return n(r.management_fee) + n(r.expenses) + n(r.loan_repayment);
}

// Credit notes and the deposits/utilities HQ adds (or other amounts it takes off).
function adjustments(r: Row): number {
    return n(r.credit_notes) + n(r.other);
}

function signedMoney(value: number): string {
    if (Math.abs(value) < 0.005) return "";
    const text = Math.abs(value).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return value < 0 ? `− ${text}` : text;
}

export function incomeStatementPdf(statement: Row, settings: Record<string, string>) {
    const from = letterhead(statement.issuer, settings);
    const landlord = statement.landlord ?? {};
    const entries: Row[] = Array.isArray(statement.entries) ? statement.entries : [];
    const byProperty: Row[] = Array.isArray(statement.by_property) ? statement.by_property : [];
    const t = statement.totals ?? {};
    const period = `${longDate(statement.from)} – ${longDate(statement.to)}`;
    const processing = n(statement.processing);

    const summary: Array<[string, number, boolean?]> = [
        ["Rent collected", n(t.collected)],
        ["Management fees", -n(t.management_fee)],
        ["Property expenses", -n(t.expenses)],
    ];
    if (n(t.loan_repayment)) summary.push(["Loan repayments", -n(t.loan_repayment)]);
    if (n(t.credit_notes)) summary.push(["Credit notes", n(t.credit_notes)]);
    if (n(t.other)) summary.push(["Deposits, utilities & other", n(t.other)]);
    summary.push(["Net payouts", n(t.net_payout), true]);

    const content: Content[] = [
        header(from, "INCOME STATEMENT", period),
        {
            columns: [
                fill({
                    stack: [
                        sectionTitle("Landlord"),
                        { text: String(landlord.name ?? ""), bold: true, size: 11 },
                        facts([
                            ["Account no.", String(landlord.account_number ?? "")],
                            ["Phone", String(landlord.phone ?? "")],
                            ["Email", String(landlord.email ?? "")],
                            ["Payouts", String(entries.length)],
                        ]),
                    ],
                }),
                {
                    width: 230,
                    stack: [
                        sectionTitle("Summary"),
                        ...summary.map(([label, value, strong]) => ({
                            columns: [
                                { text: label, color: strong ? COLORS.ink : COLORS.muted, size: 9.5, bold: Boolean(strong) },
                                { text: kes(value), align: "right" as const, size: 9.5, bold: Boolean(strong) },
                            ],
                            padding: [3, 8] as [number, number],
                        })),
                        {
                            columns: [
                                { text: "Paid to you", bold: true },
                                { text: kes(t.paid), bold: true, align: "right", color: COLORS.mint },
                            ],
                            background: COLORS.wash,
                            padding: [6, 8],
                            radius: 4,
                            margin: [4, 0, 0, 0],
                        },
                    ],
                },
            ],
            gap: 24,
            margin: [0, 0, 20, 0],
        },
    ];

    if (entries.length === 0) {
        content.push({ text: "No payouts were made in this period.", color: COLORS.muted, margin: [0, 0, 10, 0] });
    } else {
        content.push(
            sectionTitle("Payouts"),
            {
                table: {
                    columns: [
                        { header: "Paid on", width: 62, value: (r: Row) => longDate(r.date) },
                        {
                            header: "Property",
                            width: "*",
                            value: (r: Row) => ({ text: [String(r.property ?? ""), { text: `\n${r.period ?? ""} · PAYOUT-${r.id}`, size: 8, color: COLORS.muted }] }),
                        },
                        { header: "Collected", width: 70, align: "right", value: (r: Row) => money(r.collected) },
                        { header: "Deductions", width: 70, align: "right", value: (r: Row) => signedMoney(-deductions(r)) },
                        { header: "Adjustments", width: 70, align: "right", value: (r: Row) => signedMoney(adjustments(r)) },
                        { header: "Paid", width: 72, align: "right", value: (r: Row) => ({ text: money(r.paid), bold: true }) },
                    ],
                    rows: entries,
                    footer: [[
                        { content: { text: "Total", bold: true }, colSpan: 2 },
                        { content: { text: money(t.collected), bold: true }, align: "right" },
                        { content: { text: signedMoney(-deductions(t)), bold: true }, align: "right" },
                        { content: { text: signedMoney(adjustments(t)), bold: true }, align: "right" },
                        { content: { text: money(t.paid), bold: true }, align: "right" },
                    ]],
                    borders: "horizontal",
                    borderColor: COLORS.line,
                    headerStyle: { bold: true, size: 8.5, color: COLORS.muted, background: COLORS.wash },
                    footerStyle: { background: COLORS.wash },
                    fontSize: 9,
                    padding: [5, 6],
                    dontBreakRows: true,
                },
            },
        );
    }

    if (byProperty.length > 1) {
        content.push(
            sectionTitle("By property", 18),
            {
                table: {
                    columns: [
                        { header: "Property", width: "*", value: (r: Row) => String(r.property ?? "") },
                        { header: "Payouts", width: 50, align: "right", value: (r: Row) => String(r.payouts ?? 0) },
                        { header: "Collected", width: 78, align: "right", value: (r: Row) => money(r.collected) },
                        { header: "Fees", width: 70, align: "right", value: (r: Row) => signedMoney(-n(r.management_fee)) },
                        { header: "Paid", width: 78, align: "right", value: (r: Row) => ({ text: money(r.paid), bold: true }) },
                    ],
                    rows: byProperty,
                    borders: "horizontal",
                    borderColor: COLORS.line,
                    headerStyle: { bold: true, size: 8.5, color: COLORS.muted, background: COLORS.wash },
                    fontSize: 9,
                    padding: [4, 6],
                },
            },
        );
    }

    content.push({
        text: [
            "All amounts in KES. Deductions are management fees, property expenses and loan repayments; adjustments are credit notes and amounts passed through to you such as deposits and shared utilities.",
            n(t.held_back) > 0 ? ` ${kes(t.held_back)} of net payouts in this period was not paid out and stays on your account with the office.` : "",
            processing > 0 ? ` A further ${kes(processing)} is being paid out and will show here once it is confirmed.` : "",
        ],
        size: 8.5,
        color: COLORS.muted,
        margin: [10, 0, 0, 0],
    });

    return createPdf({
        title: `Income statement ${statement.from} to ${statement.to}`,
        author: from.name,
        subject: `Income statement for ${landlord.name ?? "landlord"}`,
        size: "A4",
        margins: [48, 44, 56, 44],
        defaultStyle: { font: "Helvetica", size: 10, color: COLORS.ink, lineHeight: 1.3 },
        footer: footerFor(settings.site_name || from.name, "landlord portal"),
        content,
    });
}
