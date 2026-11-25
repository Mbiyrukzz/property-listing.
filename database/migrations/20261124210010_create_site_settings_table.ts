import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("site_settings", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("key", 120).unique();
        table.text("value");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("site_settings");
};
