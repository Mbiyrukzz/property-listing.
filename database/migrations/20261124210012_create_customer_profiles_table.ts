import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("customer_profiles", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").notNullable().unique();
        table.string("phone", 40);
        table.string("preferred_contact", 20).default("phone");
        table.string("looking_for", 20);
        table.string("preferred_location", 190);
        table.decimal("budget_max", 14, 2);
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("customer_profiles");
};
