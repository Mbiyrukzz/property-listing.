import { Model } from "@tylix/orm";


export class SiteSetting extends Model {
    static table = "site_settings";
    static fillable: string[] = [
        "key", "value",
    ];
}
