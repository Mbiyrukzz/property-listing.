import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("rent_payments", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").notNullable().index();
        table.integer("properman_tenant_id").notNullable().index();
        table.integer("properman_payment_id").index();
        table.decimal("amount", 14, 2).notNullable();
        table.string("phone", 40);
        table.string("status", 20).notNullable().default("pending").index();
        table.string("mpesa_receipt", 40);
        table.string("message", 255);
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("rent_payments");
};
