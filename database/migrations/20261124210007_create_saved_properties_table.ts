import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("saved_properties", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").notNullable().index();
        table.integer("property_id").notNullable().index();
        table.timestamps();
        table.unique(["user_id", "property_id"]);
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("saved_properties");
};
