import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("property_views", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("property_id").notNullable().index();
        table.integer("user_id").index();
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("property_views");
};
