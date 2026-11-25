import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("applications", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("kind", 20).notNullable().default("rental").index();
        table.integer("property_id").notNullable().index();
        table.integer("unit_id");
        table.integer("user_id").notNullable().index();
        table.string("full_name", 160).notNullable();
        table.string("email", 190);
        table.string("phone", 40);
        table.string("id_number", 40);
        table.string("occupation", 120);
        table.string("employer", 160);
        table.decimal("monthly_income", 14, 2);
        table.decimal("offer_amount", 14, 2);
        table.string("financing", 20);
        table.date("move_in_date");
        table.integer("occupants");
        table.text("notes");
        table.string("status", 20).notNullable().default("submitted").index();
        table.text("review_notes");
        table.integer("reviewed_by");
        table.datetime("reviewed_at");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("applications");
};
