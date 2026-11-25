import { Model } from "@tylix/orm";

// A unit inside a Properman property. Only written by app/services/ListingSync.
export class ListingUnit extends Model {
    static table = "units";
    static fillable: string[] = [
        "property_id", "external_id", "slug", "name", "unit_type", "bedrooms", "bathrooms", "rent",
        "is_vacant", "is_listed", "is_furnished", "cover_image", "images", "synced_at",
    ];
}
