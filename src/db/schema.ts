/**
 * The local SQLite schema: ids are uuidv7 strings minted on the device, timestamps are ISO-8601 UTC
 * strings, and a row is only ever deleted by stamping `deleted_at`, because
 * sync needs the tombstone and undo restores from it.
 *
 * `docs/ARCHITECTURE.md` "Tables" is the model this grows towards. A column
 * lands with the slice that first writes it, so a table here can be narrower
 * than its row there.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The sync columns, without a `user_id`: the device holds one account's
 * rows, and the push stamps the person on each.
 */
const syncColumns = {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  /** Monotonic delete generation: a device that last saw generation N cannot
   *  revive a row deleted at N+1, whatever its clock says. */
  tombstoneVersion: integer("tombstone_version").notNull().default(0),
};

/**
 * What follows the person to every device, as a key and a JSON value: today
 * whether the account is frozen and each device's last sign-in. The id comes from the key
 * (`src/db/ids.ts`), so two devices writing one setting meet one row.
 */
export const settings = sqliteTable("settings", {
  ...syncColumns,
  key: text("key").notNull(),
  value: text("value").notNull(),
});

/**
 * A cabinet: the account's own, whose id is the user id and which only the
 * server makes, or a household's, made on a device (migrations 4 and 5).
 */
export const cabinets = sqliteTable("cabinets", {
  ...syncColumns,
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull().default(""),
  /** A household's photo (F2.3), set by its owner; the personal cabinet has none. */
  photoId: text("photo_id"),
});

/** Gital's `MEMBER_ROLES`: one owner, who made the cabinet, then editors and viewers. */
export const MEMBER_ROLES = ["owner", "editor", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Who is in a cabinet (F2.1). Only the server makes a row, so its id is the
 * server's; a device writes back only its person's name and `seen_at`, and,
 * for the owner, another member's role or removal.
 */
export const cabinetMembers = sqliteTable(
  "cabinet_members",
  {
    ...syncColumns,
    cabinetId: text("cabinet_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    name: text("name").notNull().default(""),
    seenAt: text("seen_at"),
  },
  (t) => [index("idx_cabinet_members_cabinet_id").on(t.cabinetId)],
);

/**
 * A medicine row is the cabinet's, not the person's (`docs/ARCHITECTURE.md`
 * "A cabinet scopes every medicine row"): the device writes the cabinet it
 * belongs to, and the server keys the row by cabinet and id. The person's
 * own cabinet's id is their user id.
 */
const cabinetColumns = {
  ...syncColumns,
  cabinetId: text("cabinet_id").notNull(),
};

/** Whose a box is: the self, someone without an account, or a pet (F2.10). */
export const PERSON_KINDS = ["self", "person", "pet"] as const;

/** What tells one person's boxes from another's at a glance; `src/ui/theme.ts` draws each in both themes. */
export const PERSON_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

export const people = sqliteTable("people", {
  ...cabinetColumns,
  name: text("name").notNull(),
  kind: text("kind", { enum: PERSON_KINDS }).notNull().default("person"),
  /** None is the one their id falls on. */
  color: text("color", { enum: PERSON_COLORS }),
  /** How many days before a box of theirs runs out it is near its end; none is the cabinet's. */
  warnDays: integer("warn_days"),
  photoId: text("photo_id"),
});

/** A place a box is kept: a cupboard, a shelf, a travel bag. */
export const locations = sqliteTable("locations", {
  ...cabinetColumns,
  name: text("name").notNull(),
});

/**
 * A medicine as the cabinet knows it, whatever boxes of it are at home. One
 * with a GTIN takes its id from cabinet and GTIN (`src/db/ids.ts`), so two
 * devices scanning one box make one product.
 */
export const products = sqliteTable("products", {
  ...cabinetColumns,
  name: text("name").notNull(),
  brand: text("brand"),
  activeSubstance: text("active_substance"),
  strength: text("strength"),
  form: text("form"),
  pack: text("pack"),
  manufacturer: text("manufacturer"),
  gtin: text("gtin"),
  note: text("note"),
  starred: integer("starred", { mode: "boolean" }).notNull().default(false),
  /** On the cabinet's list of what to buy. */
  wanted: integer("wanted", { mode: "boolean" }).notNull().default(false),
  photoId: text("photo_id"),
});

/** A word the cabinet files products under — a category or a tag, one kind of thing. */
export const tags = sqliteTable("tags", {
  ...cabinetColumns,
  name: text("name").notNull(),
});

/**
 * A tag on a product. Its id is a hash of the two (`src/db/ids.ts`), so two
 * devices tagging alike offline make one row; taking the tag off tombstones it.
 */
export const productTags = sqliteTable(
  "product_tags",
  {
    ...cabinetColumns,
    productId: text("product_id").notNull(),
    tagId: text("tag_id").notNull(),
  },
  (t) => [index("idx_product_tags_product_id").on(t.productId)],
);

/** What a box is counted in; a count of each, so none converts into another. */
export const PACKAGE_UNITS = ["adet", "tablet", "kapsul", "ml", "doz", "tup"] as const;
export type PackageUnit = (typeof PACKAGE_UNITS)[number];

/** Why a box left the cabinet while its record stays; none is a box still at home. */
export const PACKAGE_DISPOSITIONS = ["lost", "disposed", "archived"] as const;

/**
 * One physical box, bottle or tube. Changing it never changes another box of
 * the same product. Its days are local `YYYY-MM-DD`, with no time zone.
 */
export const packages = sqliteTable(
  "packages",
  {
    ...cabinetColumns,
    productId: text("product_id").notNull(),
    /** Whose box it is; none is unassigned. */
    personId: text("person_id"),
    locationId: text("location_id"),
    unit: text("unit", { enum: PACKAGE_UNITS }).notNull(),
    expiresOn: text("expires_on"),
    openedOn: text("opened_on"),
    /** How many days a box is good for once opened, apart from its printed expiry. */
    useWithinDays: integer("use_within_days"),
    /** At or below this many thousandths the box is running low; none never is. */
    lowMilli: integer("low_milli"),
    serial: text("serial"),
    lot: text("lot"),
    nickname: text("nickname"),
    acquiredOn: text("acquired_on"),
    acquiredFrom: text("acquired_from"),
    note: text("note"),
    disposition: text("disposition", { enum: PACKAGE_DISPOSITIONS }),
    /** Its own warning ahead of its expiry, over its owner's. */
    warnDays: integer("warn_days"),
    photoId: text("photo_id"),
    /** The member asked to check it (F2.9), and when; both or neither. Cleared once checked. */
    checkOf: text("check_of"),
    checkAskedAt: text("check_asked_at"),
  },
  (t) => [index("idx_packages_product_id").on(t.productId)],
);

/** Why a box's amount moved; the sign says which way. */
export const MOVE_REASONS = ["initial", "use", "add", "correction"] as const;

/**
 * What went into a box or came out of it, in thousandths of its unit, so a
 * dose of 2.5 ml is whole. What a box holds is the sum of its moves.
 */
export const packageMoves = sqliteTable(
  "package_moves",
  {
    ...cabinetColumns,
    packageId: text("package_id").notNull(),
    quantityMilli: integer("quantity_milli").notNull(),
    reason: text("reason", { enum: MOVE_REASONS }).notNull(),
    /** The account that wrote it, stamped by the server (F2.8); none until it is pushed, which is this device's own. */
    createdBy: text("created_by"),
  },
  (t) => [index("idx_package_moves_package_id").on(t.packageId)],
);

/**
 * What an edit changed on a box, as JSON: each field it changed, before and
 * after. Its moves are its amount's history; this is the rest's.
 */
export const packageChanges = sqliteTable(
  "package_changes",
  {
    ...cabinetColumns,
    packageId: text("package_id").notNull(),
    changes: text("changes").notNull(),
    /** As a move's. */
    createdBy: text("created_by"),
  },
  (t) => [index("idx_package_changes_package_id").on(t.packageId)],
);

/** What a document is; `docs/TASKS.md` F3.3. */
export const DOCUMENT_KINDS = ["prescription", "lab", "discharge", "doctor_note", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The files a document may be; the app draws one by this, never by what Storage says. */
export const DOCUMENT_FILE_TYPES = ["pdf", "jpeg"] as const;
export type DocumentFileType = (typeof DOCUMENT_FILE_TYPES)[number];

/**
 * A prescription, a lab result, a letter (F3.1–F3.5), in a cabinet as a box
 * is: its own cabinet is "only me", a household's is the household's. Its
 * file is `file_id` in `document_files` and Storage (`src/sync/documents.ts`).
 */
export const documents = sqliteTable("documents", {
  ...cabinetColumns,
  /** Whose it is; none is nobody's in particular. */
  personId: text("person_id"),
  kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
  title: text("title").notNull(),
  /** The local day it was written. */
  issuedOn: text("issued_on"),
  note: text("note"),
  /** An e-prescription's code or a paper one's number. */
  reference: text("reference"),
  fileId: text("file_id"),
  fileType: text("file_type", { enum: DOCUMENT_FILE_TYPES }),
  byteSize: integer("byte_size"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  /** Who added it, stamped by the server; none until it is pushed, which is this device's own. */
  createdBy: text("created_by"),
});

/**
 * A document naming a product or a box (F3.4), in the document's cabinet,
 * whichever cabinet the product or box is in. Its id is a hash of the two
 * (`src/db/ids.ts`); taking it off tombstones it.
 */
export const documentLinks = sqliteTable(
  "document_links",
  {
    ...cabinetColumns,
    documentId: text("document_id").notNull(),
    productId: text("product_id"),
    packageId: text("package_id"),
  },
  (t) => [index("idx_document_links_document_id").on(t.documentId)],
);

/**
 * A medicine taken on a schedule (F3.7), for a person, in a cabinet as a box
 * is: its times of day on its weekdays, from its first day to its last. When
 * it names a box, a dose taken comes out of it (F3.8). Its days are local
 * `YYYY-MM-DD` and its times local `HH:MM`, as the person reads them.
 */
export const dosePlans = sqliteTable("dose_plans", {
  ...cabinetColumns,
  productId: text("product_id").notNull(),
  packageId: text("package_id"),
  personId: text("person_id"),
  /** One dose, in thousandths of the box's unit, as a move counts it. */
  amountMilli: integer("amount_milli").notNull(),
  /** Its times of day as a JSON array, earliest first. */
  times: text("times").notNull(),
  /** Its weekdays, Monday 1, Tuesday 2 … Sunday 64; every day is 127. */
  weekdays: integer("weekdays").notNull(),
  startsOn: text("starts_on").notNull(),
  endsOn: text("ends_on"),
  /** How the prescription says to take it. */
  instructions: text("instructions"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  /** Who planned it, stamped by the server; none until it is pushed, which is this device's own. */
  createdBy: text("created_by"),
});

/** What became of a dose (F3.8); a dose nobody answered is none of these. */
export const DOSE_STATUSES = ["taken", "skipped", "snoozed", "missed"] as const;
export type DoseStatus = (typeof DOSE_STATUSES)[number];

/**
 * The answer to one dose of a plan, in the plan's cabinet. Its id is a hash
 * of the plan and the dose (`src/db/ids.ts`), so two devices answering it
 * meet one row and the later answer stands.
 */
export const doseLogs = sqliteTable(
  "dose_logs",
  {
    ...cabinetColumns,
    planId: text("plan_id").notNull(),
    dueOn: text("due_on").notNull(),
    dueTime: text("due_time").notNull(),
    status: text("status", { enum: DOSE_STATUSES }).notNull(),
    /** When a dose put off is to be said again. */
    snoozedUntil: text("snoozed_until"),
    /** The move a dose taken made in the plan's box, taken back when the answer changes. */
    moveId: text("move_id"),
    /** Who answered last, stamped by the server at every answer; none until it is pushed, which is this device's own. */
    answeredBy: text("answered_by"),
  },
  (t) => [index("idx_dose_logs_plan_id").on(t.planId)],
);

/**
 * Local only: a document's file, base64, as `photos` holds a photo's. Sent
 * once and fetched only when the document is opened.
 */
export const documentFiles = sqliteTable("document_files", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
  /** When Storage took it, or when it came from there; `null` is still to send. */
  uploadedAt: text("uploaded_at"),
});

/**
 * Local only: a photo's bytes, beside the row that names it by `photo_id`,
 * never in the outbox — they go to Storage (`src/sync/photos.ts`). Gital's:
 * a photo is never edited, a new one is a new id, so an undo that puts the
 * old id back finds it here.
 */
export const photos = sqliteTable("photos", {
  id: text("id").primaryKey(),
  /** The longest edge at most `PHOTO_EDGE`, for the full view. */
  data: text("data").notNull(),
  /** At most `THUMB_EDGE`, for a row's tile, so a list never decodes the full photo. */
  thumb: text("thumb").notNull(),
  createdAt: text("created_at").notNull(),
  /** When Storage took both sizes, or when they came from it; `null` is still to send. */
  uploadedAt: text("uploaded_at"),
});

/** Local only: every write waiting to be pushed. Never synced itself. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    op: text("op", { enum: ["upsert"] }).notNull().default("upsert"),
    payload: text("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_outbox_table_id").on(t.tableName, t.id),
    index("idx_outbox_table_row_id_id").on(t.tableName, t.rowId, t.id),
  ],
);

/**
 * Local only: an outbox event the push would not send, or the server would not
 * take . The row itself stays as it is on the device; this is the
 * clue, kept until a retry sends it or the person dismisses it.
 */
export const syncDeadLetters = sqliteTable("sync_dead_letters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  outboxId: integer("outbox_id").notNull().unique(),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  payload: text("payload").notNull(),
  reason: text("reason", { enum: ["malformed_payload", "invalid_row", "refused"] }).notNull(),
  quarantinedAt: text("quarantined_at").notNull(),
});

/** Local only: how far each table has been pulled, as `"<updated_at>|<id>"`. */
export const syncState = sqliteTable("sync_state", {
  tableName: text("table_name").primaryKey(),
  lastPulledAt: text("last_pulled_at").notNull(),
});

/**
 * The `sync_state` key under which `migrateDb` names the columns an update
 * added, as a JSON list, until the pull after it has finished: the push leaves
 * such a column out while it holds the migration's empty value.
 */
export const UNPULLED = "unpulled:";

/**
 * Parents before children, the order a push sends them in. Memberships last,
 * as Gital's: a device only ever narrows one, so what it wrote just before
 * leaving lands before the leaving does.
 */
export const SYNCED_TABLES = { settings, cabinets, people, locations, products, packages, package_moves: packageMoves, package_changes: packageChanges, tags, product_tags: productTags, documents, document_links: documentLinks, dose_plans: dosePlans, dose_logs: doseLogs, cabinet_members: cabinetMembers } as const;

export type SyncedTableName = keyof typeof SYNCED_TABLES;
