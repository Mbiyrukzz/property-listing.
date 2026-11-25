// Site settings (contact details, homepage wording) and editable pages.
// Stored in site_settings / site_pages; these defaults apply until an admin
// changes them on /admin/content.

import { SiteSetting } from "../models/SiteSetting.js";
import { SitePage } from "../models/SitePage.js";
import { cache } from "@tylix/core";

export const SETTING_DEFAULTS: Record<string, string> = {
    site_name: "Barani Better Homes",
    tagline: "Homes, land and commercial space across Kenya",
    hero_title: "Find your next home, plot or office",
    hero_subtitle: "Vacant units straight from the landlord's books, properties for sale and land you can visit this week.",
    phone: "",
    whatsapp: "+254 786 514182",
    email: "info@baranibetterhomes.com",
    address: "",
    office_hours: "Mon–Fri 8:00–17:00, Sat 9:00–13:00",
    facebook: "",
    instagram: "",
    about_short: "A Kenyan property agency for tenants, buyers and landlords. We let and sell homes, land and business premises, and manage rental buildings for their owners, from finding tenants to collecting the rent.",
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

const CACHE_KEY = "site:settings";

export async function getSettings(): Promise<Record<string, string>> {
    return cache.remember(CACHE_KEY, 60, async () => {
        const rows = (await SiteSetting.all()) as { key: string; value: string | null }[];
        const out: Record<string, string> = { ...SETTING_DEFAULTS };
        for (const row of rows) {
            if (SETTING_KEYS.includes(row.key)) out[row.key] = row.value ?? "";
        }
        return out;
    });
}

export async function saveSettings(input: Record<string, unknown>): Promise<Record<string, string>> {
    for (const key of SETTING_KEYS) {
        if (!(key in input)) continue;
        const value = String(input[key] ?? "").slice(0, 2000);
        await SiteSetting.updateOrCreate({ key }, { key, value });
    }
    await cache.forget(CACHE_KEY);
    return getSettings();
}

export const ABOUT_BODY = [
    "Barani Better Homes is a property agency serving tenants, buyers and landlords across Kenya. We help people find homes, plots and business premises, and we look after rental buildings on behalf of their owners.",
    "For tenants and buyers: our rental listings come straight from the system we use to manage our buildings, so a unit shown as vacant here is vacant today. When a tenant moves in, it leaves the site on its own. Book a viewing online and an agent calls to confirm.",
    "For landlords: we take the day-to-day work off your hands. We market your vacant units, find and vet tenants, collect the rent and follow up arrears, arrange repairs, and keep you informed with clear statements. Your tenants can check their balance and pay rent by M-Pesa from our tenant portal, which means fewer missed payments and less chasing.",
    "Whether you own a single rental unit or a whole block, we would like to hear from you.",
].join("\n\n");

export const DEFAULT_PAGES = [
    {
        slug: "about",
        title: "About Barani Better Homes",
        body: ABOUT_BODY,
    },
    {
        slug: "terms",
        title: "Terms of use",
        body: "Listings are provided for information. Prices and availability can change; we confirm both before any viewing or application.\n\nApplications are reviewed by the landlord or their agent and are not a tenancy or sale agreement.",
    },
    {
        slug: "privacy",
        title: "Privacy",
        body: "We use the details you give us (name, phone, email and application details) only to answer your enquiry, arrange viewings and process applications.\n\nTenant portal data (balances, invoices and receipts) is read from our property management system when you open the portal and is not shared with anyone else.",
    },
];

export async function ensureDefaultPages(): Promise<void> {
    for (const page of DEFAULT_PAGES) {
        const existing = await SitePage.query().where("slug", page.slug).first();
        if (!existing) await SitePage.create({ ...page, is_published: 1 });
    }
}
