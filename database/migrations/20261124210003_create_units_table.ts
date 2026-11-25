import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("units", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("property_id").notNullable().index();
        table.integer("external_id").unique();
        table.string("slug", 190);
        table.string("name", 190).notNullable();
        table.string("unit_type", 60);
        table.integer("bedrooms");
        table.integer("bathrooms");
        table.decimal("rent", 14, 2).default(0);
        table.boolean("is_vacant").default(false).index();
        // Vacant, not hidden in Properman, and on a published property.
        table.boolean("is_listed").default(false).index();
        table.boolean("is_furnished").default(false);
        table.string("cover_image", 500);
        table.text("images");
        table.datetime("synced_at");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("units");
};
