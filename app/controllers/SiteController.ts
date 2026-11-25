// Public site content: settings (contact details, homepage wording), editable
// pages and the agent list.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { SitePage } from "../models/SitePage.js";
import { Agent } from "../models/Agent.js";
import { CATEGORIES, PURPOSES } from "../services/catalog.js";
import { getSettings } from "../services/site.js";

export class SiteController {
    async site(_req: TylixRequest, res: TylixResponse) {
        const pages = (await SitePage.query().where("is_published", 1).orderBy("title", "ASC").get()) as Record<string, any>[];
        return res.json({
            settings: await getSettings(),
            pages: pages.map((p) => ({ slug: p.slug, title: p.title })),
            categories: CATEGORIES,
            purposes: PURPOSES,
        });
    }

    async page(req: TylixRequest, res: TylixResponse) {
        const slug = String(req.params.slug ?? "").slice(0, 120);
        const page = (await SitePage.query().where("slug", slug).where("is_published", 1).first()) as Record<string, any> | null;
        if (!page) {
            res.status(404);
            return res.json({ error: "Page not found." });
        }
        return res.json({ data: { slug: page.slug, title: page.title, body: page.body ?? "", updatedAt: page.updated_at } });
    }

    async agents(_req: TylixRequest, res: TylixResponse) {
        const rows = (await Agent.query().where("is_active", 1).orderBy("name", "ASC").get()) as Record<string, any>[];
        return res.json({
            data: rows.map((a) => ({
                id: a.id,
                name: a.name,
                title: a.title ?? "",
                phone: a.phone ?? "",
                whatsapp: a.whatsapp ?? "",
                email: a.email ?? "",
                photo: a.photo ?? null,
                bio: a.bio ?? "",
            })),
        });
    }
}
