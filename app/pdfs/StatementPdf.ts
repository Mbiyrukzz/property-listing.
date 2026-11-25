// A tenant's account statement for a period, as a PDF, from Properman's
// ledger (GET /tenants/{id}/statement?from=&to=).

import { createPdf } from "@tylix/pdf";
import type { Content } from "@tylix/pdf";
import { COLORS, facts, fill, footerFor, header, kes, letterhead, longDate, money, sectionTitle } from "./shared.js";

type Row = Record<string, any>;

export function statementPdf(statement: Row, settings: Record<string, string>) {
    const from = letterhead(statement.issuer, settings);
    const tenant = statement.tenant ?? {};
    const entries: Row[] = Array.isArray(statement.entries) ? statement.entries : [];
    const period = `${longDate(statement.from)} – ${longDate(statement.to)}`;
    const premises = [statement.property?.name, statement.unit?.name].filter(Boolean).join(" · ");
    const opening = Number(statement.opening_balance) || 0;
    const closing = Number(statement.closing_balance) || 0;
    const otherCredits = Number(statement.total_other_credits) || 0;
    const wallet = Number(statement.wallet_balance) || 0;

    const rows: Row[] = [
        { date: statement.from, description: "Opening balance", reference: "", debit: 0, credit: 0, balance: opening, opening: true },
        ...entries,
    ];

    const content: Content[] = [
        header(from, "STATEMENT", period),
        {
            columns: [
                fill({
                    stack: [
                        sectionTitle("Account holder"),
                        { text: String(tenant.name ?? ""), bold: true, size: 11 },
                        facts([
                            ["Account no.", String(tenant.account_number ?? "")],
                            ["Premises", premises],
                            ["Phone", String(tenant.phone ?? "")],
                        ]),
                    ],
                }),
                {
                    width: 220,
                    stack: [
                        sectionTitle("Summary"),
                        summaryRow("Opening balance", kes(opening)),
                        summaryRow("Charges", kes(statement.total_charges)),
                        summaryRow("Payments", kes(-(Number(statement.total_payments) || 0))),
                        ...(otherCredits > 0 ? [summaryRow("Adjustments", kes(-otherCredits))] : []),
                        {
                            columns: [
                                { text: closing < 0 ? "In your favour" : "Balance due", bold: true },
                                { text: kes(Math.abs(closing)), bold: true, align: "right", color: closing > 0 ? COLORS.coral : COLORS.mint },
                            ],
                            background: COLORS.wash,
                            padding: [6, 8],
                            radius: 4,
                            margin: [4, 0, 0, 0],
                        },
                        ...(wallet > 0 ? [summaryRow("Credit held", kes(wallet))] : []),
                    ],
                },
            ],
            gap: 24,
            margin: [0, 0, 20, 0],
        },
        {
            table: {
                columns: [
                    { header: "Date", width: 64, value: (r: Row) => longDate(r.date) },
                    {
                        header: "Details",
                        width: "*",
                        value: (r: Row) => r.opening
                            ? { text: "Opening balance", bold: true }
                            : { text: [String(r.description ?? ""), r.reference ? { text: `\n${r.reference}`, size: 8, color: COLORS.muted } : ""] },
                    },
                    { header: "Charges", width: 72, align: "right", value: (r: Row) => money(r.debit) },
                    { header: "Payments", width: 72, align: "right", value: (r: Row) => money(r.credit) },
                    { header: "Balance", width: 80, align: "right", value: (r: Row) => ({ text: balanceText(r.balance), bold: Boolean(r.opening) }) },
                ],
                rows,
                footer: [[
                    { content: { text: "Closing balance", bold: true }, colSpan: 2 },
                    { content: { text: money(statement.total_charges), bold: true }, align: "right" },
                    { content: { text: money(Number(statement.total_payments) + otherCredits), bold: true }, align: "right" },
                    { content: { text: balanceText(closing), bold: true }, align: "right" },
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
        {
            text: [
                "All amounts in KES. Balance is what you owe; ",
                { text: "CR", bold: true },
                " marks a balance in your favour.",
                wallet > 0
                    ? ` Credit held (${kes(wallet)}) is money received that hasn't gone onto an invoice yet; it is used for your next invoices.`
                    : "",
            ],
            size: 8.5,
            color: COLORS.muted,
            margin: [8, 0, 0, 0],
        },
    ];

    if (closing > 0 && statement.pay?.paybill) {
        content.push({
            box: [
                { text: "How to pay", bold: true, margin: [0, 0, 4, 0] },
                {
                    text: [
                        "M-Pesa Paybill ",
                        { text: String(statement.pay.paybill), bold: true },
                        ", account number ",
                        { text: String(statement.pay.account_number ?? tenant.account_number ?? ""), bold: true },
                        ". Or pay from the tenant portal.",
                    ],
                    size: 9.5,
                },
            ],
            background: "#EFF5FC",
            padding: 12,
            radius: 6,
            margin: [16, 0, 0, 0],
            unbreakable: true,
        });
    }

    return createPdf({
        title: `Statement ${statement.from} to ${statement.to}`,
        author: from.name,
        subject: `Account statement for ${tenant.name ?? "tenant"}`,
        size: "A4",
        margins: [48, 44, 56, 44],
        defaultStyle: { font: "Helvetica", size: 10, color: COLORS.ink, lineHeight: 1.3 },
        footer: footerFor(settings.site_name || from.name),
        content,
    });
}

function balanceText(value: unknown): string {
    const n = Number(value) || 0;
    if (Math.abs(n) < 0.005) return "0.00";
    const text = Math.abs(n).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? `${text} CR` : text;
}

function summaryRow(label: string, value: string): Content {
    return {
        columns: [
            { text: label, color: COLORS.muted, size: 9.5 },
            { text: value, align: "right", size: 9.5 },
        ],
        padding: [3, 8],
    };
}
