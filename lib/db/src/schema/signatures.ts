import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const signaturesTable = pgTable("signatures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  imageUrl: text("image_url").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SignatureRow = typeof signaturesTable.$inferSelect;
export type InsertSignature = typeof signaturesTable.$inferInsert;
