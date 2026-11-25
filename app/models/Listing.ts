import { Model } from "@tylix/orm";

// A property on the public site. Rows with source "properman" are written
// by app/services/ListingSync and must not be edited by hand except for the
// marketing fields (is_featured, agent_id, features); see MARKETING_FIELDS.
export class Listing extends Model {
    static table = "properties";
    static fillable: string[] = [
        "source", "external_id", "slug", "title", "purpose", "category", "location", "address",
        "description", "price", "bedrooms", "bathrooms", "size_sqm", "land_size", "features",
        "cover_image", "images", "status", "total_units", "vacant_units", "is_published",
        "is_featured", "agent_id", "search_text", "published_at", "synced_at",
    ];
}
