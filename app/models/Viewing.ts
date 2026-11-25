import { Model } from "@tylix/orm";


export class Viewing extends Model {
    static table = "viewings";
    static fillable: string[] = [
        "property_id", "unit_id", "user_id", "agent_id", "name", "email", "phone",
        "preferred_date", "preferred_time", "scheduled_for", "notes", "status", "admin_notes",
    ];
}
