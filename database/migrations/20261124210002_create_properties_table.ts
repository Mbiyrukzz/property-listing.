import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("properties", (table: CreateTableBuilder) => {
        table.increments("id");
        // "properman" rows are owned by the sync; "manual" rows are created
        // in the BBHomes admin (sales and land that Properman does not track).
        table.string("source", 20).notNullable().default("manual").index();
        table.integer("external_id").index();
        table.string("slug", 190).unique();
        table.string("title", 200).notNullable();
        table.string("purpose", 10).notNullable().default("rent").index();
        table.string("category", 30).notNullable().default("apartment").index();
        table.string("location", 190);
        table.string("address", 255);
        table.text("description");
        // Sale: the asking price. Rent: the lowest rent among listed units.
        table.decimal("price", 14, 2).default(0).index();
        table.integer("bedrooms");
        table.integer("bathrooms");
        table.decimal("size_sqm", 12, 2);
        table.string("land_size", 60);
        table.text("features");
        table.string("cover_image", 500);
        table.text("images");
        table.string("status", 20).notNullable().default("available").index();
        table.integer("total_units").default(0);
        table.integer("vacant_units").default(0);
        table.boolean("is_published").default(false).index();
        table.boolean("is_featured").default(false).index();
        table.integer("agent_id").index();
        table.text("search_text");
        table.datetime("published_at");
        table.datetime("synced_at");
        table.timestamps();
        table.unique(["source", "external_id"]);
        table.index(["is_published", "purpose", "category"]);
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("properties");
};
