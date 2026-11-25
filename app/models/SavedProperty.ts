import { Model } from "@tylix/orm";


export class SavedProperty extends Model {
    static table = "saved_properties";
    static fillable: string[] = [
        "user_id", "property_id",
    ];
}
