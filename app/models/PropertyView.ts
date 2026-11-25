import { Model } from "@tylix/orm";

// One row per listing page view; powers viewing history and reports.
export class PropertyView extends Model {
    static table = "property_views";
    static fillable: string[] = [
        "property_id", "user_id",
    ];
}
