import { Model } from "@tylix/orm";

// Editable pages such as About, Terms and Privacy (/p/<slug>).
export class SitePage extends Model {
    static table = "site_pages";
    static fillable: string[] = [
        "slug", "title", "body", "is_published",
    ];
}
