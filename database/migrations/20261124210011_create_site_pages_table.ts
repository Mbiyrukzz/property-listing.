import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("site_pages", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("slug", 120).unique();
        table.string("title", 200).notNullable();
        table.text("body");
        table.boolean("is_published").default(true);
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("site_pages");
};
