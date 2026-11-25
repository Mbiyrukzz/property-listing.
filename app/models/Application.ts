import { Model } from "@tylix/orm";

// Rental and purchase applications. Applicants must be signed in.
export class Application extends Model {
    static table = "applications";
    static fillable: string[] = [
        "kind", "property_id", "unit_id", "user_id", "full_name", "email", "phone", "id_number",
        "occupation", "employer", "monthly_income", "offer_amount", "financing", "move_in_date",
        "occupants", "notes", "status", "review_notes", "reviewed_by", "reviewed_at",
    ];
}
