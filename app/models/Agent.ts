import { Model } from "@tylix/orm";

// Sales and letting agents shown on listings and assigned to enquiries.
export class Agent extends Model {
    static table = "agents";
    static fillable: string[] = [
        "name", "title", "email", "phone", "whatsapp", "photo", "bio", "user_id", "is_active",
    ];
}
