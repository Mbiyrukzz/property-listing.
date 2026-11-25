import { Model } from "@tylix/orm";

// Extra customer details, kept apart from the generated User model.
export class CustomerProfile extends Model {
    static table = "customer_profiles";
    static fillable: string[] = [
        "user_id", "phone", "preferred_contact", "looking_for", "preferred_location", "budget_max",
    ];
}
