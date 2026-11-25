import { Model } from "@tylix/orm";


export class Enquiry extends Model {
    static table = "enquiries";
    static fillable: string[] = [
        "kind", "property_id", "unit_id", "user_id", "agent_id", "name", "email", "phone",
        "message", "status", "admin_notes",
    ];
}
