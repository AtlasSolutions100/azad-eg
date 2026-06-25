import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { packagesTable } from "./packages";

/**
 * A manual override for a Labor Attachment cell. The Labor Attachment is
 * auto-calculated from timesheets by default; when a user edits a cell directly,
 * the override is persisted here so downstream generation honors it and the UI
 * can visually distinguish auto-calculated cells from manually edited ones.
 * cellKey identifies the target cell/field within the Labor Attachment.
 */
export const laborOverridesTable = pgTable(
  "labor_overrides",
  {
    id: serial("id").primaryKey(),
    packageId: integer("package_id").notNull().references(() => packagesTable.id, { onDelete: "cascade" }),
    cellKey: text("cell_key").notNull(),
    value: text("value").notNull(),
    editedBy: text("edited_by"),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("labor_overrides_package_cell_unique").on(t.packageId, t.cellKey)],
);

export type LaborOverrideRow = typeof laborOverridesTable.$inferSelect;
export type InsertLaborOverride = typeof laborOverridesTable.$inferInsert;
