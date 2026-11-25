// A tenant's invoice as a PDF, from Properman's invoice detail
// (GET /tenants/{id}/invoices/{invoice}).

import { createPdf } from "@tylix/pdf";
import type { Content } from "@tylix/pdf";
import {
    COLORS, facts, fill, footerFor, header, invoiceTypeLabel, kes, letterhead, longDate, money, sectionTitle,
} from "./shared.js";

type Row = Record<string, any>;

const STATUS: Record<string, { label: string; color: string }> = {
    paid: { label: "PAID", color: COLORS.mint },
    partial: { label: "PARTLY PAID", color: COLORS.brand },
    unpaid: { label: "UNPAID", color: COLORS.coral },
    waived: { label: "WAIVED", color: COLORS.muted },
    cancelled: { label: "CANCELLED", color: COLORS.muted },
};

const METHOD: Record<string, string> = {
    mpesa: "M-Pesa",
    bank: "Bank",
    cash: "Cash",
    wallet: "Account credit",
};

export function invoicePdf(invoice: Row, settings: Record<string, string>) {
    const from = letterhead(invoice.issuer, settings);
    const status = STATUS[String(invoice.status)] ?? STATUS.unpaid;
    const type = invoiceTypeLabel(invoice.type);
    const number = String(invoice.invoice_number ?? invoice.id ?? "");
    const tenant = invoice.tenant ?? {};
    const items: Row[] = Array.isArray(invoice.items) && invoice.items.length > 0
        ? invoice.items
        : [{ name: type, description: "", quantity: 1, price: invoice.total, total: invoice.total }];
    const payments: Row[] = Array.isArray(invoice.payments) ? invoice.payments.filter((p: Row) => Number(p.amount) > 0) : [];
    const toCredit = payments.reduce((sum, p) => sum + Math.max(Number(p.to_credit) || 0, 0), 0);
    const premises = [invoice.property?.name, invoice.unit?.name].filter(Boolean).join(" · ");
    const balance = Number(invoice.balance) || 0;

    const content: Content[] = [
        header(from, "INVOICE", `No. ${number}`),
        {
            columns: [
                fill({
                    stack: [
                        sectionTitle("Billed to"),
                        { text: String(tenant.name ?? ""), bold: true, size: 11 },
                        facts([
                            ["Account no.", String(tenant.account_number ?? "")],
                            ["Premises", premises],
                            ["Phone", String(tenant.phone ?? "")],
                            ["Email", String(tenant.email ?? "")],
                        ]),
                    ],
                }),
                {
                    width: 210,
                    stack: [
                        sectionTitle("Invoice"),
                        facts([
                            ["For", type],
                            ["Invoice date", longDate(invoice.invoiced_at)],
                            ["Due date", longDate(invoice.due_at)],
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
                            width: 96,
                            margin: [6, 0, 0, 0],
                        },
                    ],
                },
            ],
            gap: 24,
            margin: [0, 0, 20, 0],
        },
        {
            table: {
                columns: [
                    { header: "Description", width: "*", value: (r: Row) => ({ text: [String(r.name || type), r.description ? { text: `\n${r.description}`, size: 8.5, color: COLORS.muted } : ""] }) },
                    { header: "Qty", width: 40, align: "right", value: (r: Row) => String(Number(r.quantity) || 1) },
                    { header: "Unit price (KES)", width: 100, align: "right", value: (r: Row) => money(r.price) || "0.00" },
                    { header: "Amount (KES)", width: 100, align: "right", value: (r: Row) => money(r.total) || "0.00" },
                ],
                rows: items,
                borders: "horizontal",
                borderColor: COLORS.line,
                headerStyle: { bold: true, size: 9, color: COLORS.muted, background: COLORS.wash },
                fontSize: 10,
                padding: [7, 8],
                dontBreakRows: true,
            },
        },
        {
            columns: [
                fill({ text: "" }),
                {
                    width: 230,
                    stack: [
                        totalsRow("Total", kes(invoice.total)),
                        totalsRow("Paid", kes(invoice.paid)),
                        ...(invoice.voided ? [totalsRow(invoice.voided.reason === "waived" ? "Waived" : "Cancelled", kes(Math.max(Number(invoice.total) - Number(invoice.paid), 0)))] : []),
                        {
                            columns: [
                                { text: "Balance due", bold: true },
                                { text: kes(balance), bold: true, align: "right", color: balance > 0 ? COLORS.coral : COLORS.mint },
                            ],
                            background: COLORS.wash,
                            padding: [7, 8],
                            radius: 4,
                            margin: [4, 0, 0, 0],
                        },
                    ],
                },
            ],
            margin: [0, 10, 18, 0],
            unbreakable: true,
        },
    ];

    if (payments.length > 0) {
        content.push(
            sectionTitle("Payments received"),
            {
                table: {
                    columns: [
                        { header: "Date", width: 80, value: (p: Row) => longDate(p.paid_at) },
                        { header: "Method", width: 90, value: (p: Row) => METHOD[String(p.method)] ?? "Payment" },
                        { header: "Reference", width: "*", value: (p: Row) => String(p.reference ?? "") },
                        { header: "Receipt", width: 70, value: (p: Row) => String(p.receipt_number ?? "") },
                        { header: "Amount (KES)", width: 90, align: "right", value: (p: Row) => money(p.amount) },
                    ],
                    rows: payments,
                    borders: "horizontal",
                    borderColor: COLORS.line,
                    headerStyle: { bold: true, size: 9, color: COLORS.muted, background: COLORS.wash },
                    fontSize: 9.5,
                    padding: [6, 8],
                },
            },
        );
        if (toCredit > 0) {
            content.push({
                text: `${kes(toCredit)} paid above this invoice was kept as credit on your account.`,
                size: 8.5,
                color: COLORS.muted,
                margin: [6, 0, 0, 0],
            });
        }
    }

    if (balance > 0 && invoice.pay?.paybill) {
        content.push({
            box: [
                { text: "How to pay", bold: true, margin: [0, 0, 4, 0] },
                {
                    text: [
                        "M-Pesa Paybill ",
                        { text: String(invoice.pay.paybill), bold: true },
                        ", account number ",
                        { text: String(invoice.pay.account_number ?? tenant.account_number ?? ""), bold: true },
                        ". Or pay from the tenant portal. Payments clear your oldest invoices first.",
                    ],
                    size: 9.5,
                },
            ],
            background: "#EFF5FC",
            padding: 12,
            radius: 6,
            margin: [18, 0, 0, 0],
            unbreakable: true,
        });
    }

    return createPdf({
        title: `Invoice ${number}`,
        author: from.name,
        subject: `${type} invoice for ${tenant.name ?? "tenant"}`,
        size: "A4",
        margins: [48, 48, 56, 48],
        defaultStyle: { font: "Helvetica", size: 10, color: COLORS.ink, lineHeight: 1.3 },
        watermark: invoice.status === "paid" ? { text: "PAID", color: COLORS.mint, opacity: 0.06, size: 110 } : undefined,
        footer: footerFor(settings.site_name || from.name),
        content,
    });
}

function totalsRow(label: string, value: string): Content {
    return {
        columns: [
            { text: label, color: COLORS.muted },
            { text: value, align: "right" },
        ],
        padding: [4, 8],
    };
}
