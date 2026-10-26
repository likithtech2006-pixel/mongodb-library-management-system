const path = require("path");
const { MongoClient } = require("mongodb");

// Load settings from .env if present (Node 20.12+)
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.DB_NAME || "library_management";
const LOAN_DAYS = Number(process.env.LOAN_DAYS) || 14;
const MAX_ACTIVE_LOANS = Number(process.env.MAX_ACTIVE_LOANS) || 3;
const FINE_PER_DAY = Number(process.env.FINE_PER_DAY) || 10;
const HOLD_DAYS = Number(process.env.HOLD_DAYS) || 3;
const REMINDER_DAYS_BEFORE = Number(process.env.REMINDER_DAYS_BEFORE) || 2;
const MAX_UNPAID_FINE = Number(process.env.MAX_UNPAID_FINE ?? 100);

const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
const ISBN_PATTERN = "^(\\d{9}[\\dX]|\\d{13})$";
const PHONE_PATTERN = "^\\+?[0-9]{10,15}$";
const CASE_INSENSITIVE = { locale: "en", strength: 2 };

const client = new MongoClient(MONGO_URI);
const db = client.db(DB_NAME);
const state = { transactionsSupported: false };

// ---------------- DATA VALIDATION ----------------
// $jsonSchema checks each field; $expr adds rules that compare fields.
const validators = {
  authors: {
    $jsonSchema: {
      bsonType: "object",
      required: ["name"],
      properties: {
        name: { bsonType: "string", minLength: 1, maxLength: 100 },
        createdAt: { bsonType: "date" }
      }
    }
  },
  books: {
    $and: [
      {
        $jsonSchema: {
          bsonType: "object",
          required: ["title", "author", "authorId", "isbn", "totalCopies", "availableCopies", "heldCopies", "borrowCount"],
          properties: {
            title: { bsonType: "string", minLength: 1, maxLength: 200 },
            author: { bsonType: "string", minLength: 1, maxLength: 100 },
            authorId: { bsonType: "objectId" },
            description: { bsonType: "string", maxLength: 2000 },
            isbn: { bsonType: "string", pattern: ISBN_PATTERN },
            totalCopies: { bsonType: "int", minimum: 1, maximum: 1000 },
            availableCopies: { bsonType: "int", minimum: 0 },
            heldCopies: { bsonType: "int", minimum: 0 },
            borrowCount: { bsonType: "int", minimum: 0 },
            createdAt: { bsonType: "date" }
          }
        }
      },
      // copies on the shelf plus copies held for reservations can't exceed the total
      { $expr: { $lte: [{ $add: ["$availableCopies", "$heldCopies"] }, "$totalCopies"] } }
    ]
  },
  borrowers: {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "email", "activeLoans"],
      properties: {
        name: { bsonType: "string", minLength: 1, maxLength: 100 },
        email: { bsonType: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
        phone: { bsonType: "string", pattern: PHONE_PATTERN },
        activeLoans: { bsonType: "int", minimum: 0, maximum: MAX_ACTIVE_LOANS },
        createdAt: { bsonType: "date" }
      }
    }
  },
  loans: {
    $and: [
      {
        $jsonSchema: {
          bsonType: "object",
          required: ["bookId", "borrowerId", "issuedAt", "dueDate", "returned"],
          properties: {
            bookId: { bsonType: "objectId" },
            borrowerId: { bsonType: "objectId" },
            issuedAt: { bsonType: "date" },
            dueDate: { bsonType: "date" },
            returned: { bsonType: "bool" },
            returnedAt: { bsonType: "date" },
            fine: { bsonType: "number", minimum: 0 },
            finePaid: { bsonType: "bool" },
            finePaidAt: { bsonType: "date" },
            reminderSentAt: { bsonType: "date" },
            overdueNoticeAt: { bsonType: "date" }
          }
        }
      },
      { $expr: { $gt: ["$dueDate", "$issuedAt"] } }
    ]
  },
  reservations: {
    $and: [
      {
        $jsonSchema: {
          bsonType: "object",
          required: ["bookId", "borrowerId", "status", "active", "createdAt"],
          properties: {
            bookId: { bsonType: "objectId" },
            borrowerId: { bsonType: "objectId" },
            status: { enum: ["waiting", "ready", "fulfilled", "cancelled", "expired"] },
            active: { bsonType: "bool" },
            createdAt: { bsonType: "date" },
            readyAt: { bsonType: "date" },
            holdUntil: { bsonType: "date" },
            closedAt: { bsonType: "date" }
          }
        }
      },
      // `active` must agree with the status, and a ready reservation needs a hold deadline
      { $expr: { $eq: ["$active", { $in: ["$status", ["waiting", "ready"]] }] } },
      { $or: [{ status: { $ne: "ready" } }, { holdUntil: { $exists: true } }] }
    ]
  },
  payments: {
    $jsonSchema: {
      bsonType: "object",
      required: ["loanId", "borrowerId", "amount", "method", "paidAt"],
      properties: {
        loanId: { bsonType: "objectId" },
        borrowerId: { bsonType: "objectId" },
        amount: { bsonType: "number", minimum: 1 },
        method: { enum: ["cash", "upi", "card"] },
        paidAt: { bsonType: "date" },
        receivedBy: { bsonType: "string", maxLength: 100 }
      }
    }
  },
  notifications: {
    $jsonSchema: {
      bsonType: "object",
      required: ["type", "channel", "to", "subject", "body", "status", "createdAt"],
      properties: {
        type: { enum: ["due_soon", "overdue", "reservation_ready", "test"] },
        channel: { enum: ["email", "sms"] },
        to: { bsonType: "string", minLength: 1 },
        subject: { bsonType: "string" },
        body: { bsonType: "string" },
        status: { enum: ["sent", "logged", "failed"] },
        error: { bsonType: "string" },
        borrowerId: { bsonType: "objectId" },
        loanId: { bsonType: "objectId" },
        reservationId: { bsonType: "objectId" },
        createdAt: { bsonType: "date" }
      }
    }
  },
  auditLogs: {
    $jsonSchema: {
      bsonType: "object",
      required: ["at", "action", "entity", "summary", "actor"],
      properties: {
        at: { bsonType: "date" },
        action: { bsonType: "string", minLength: 1 },
        entity: { enum: ["book", "author", "borrower", "loan", "reservation", "payment", "backup", "system"] },
        entityId: { bsonType: "objectId" },
        summary: { bsonType: "string", minLength: 1, maxLength: 500 },
        actor: { bsonType: "string", minLength: 1, maxLength: 100 },
        ip: { bsonType: "string" }
      }
    }
  }
};

// Handles can be created before connecting; the driver connects on first use
const collections = Object.fromEntries(Object.keys(validators).map(name => [name, db.collection(name)]));

// Validators are applied on every start (collMod), so collections created
// earlier - e.g. by an old seed script - still get the rules.
async function applyValidators(db, existing) {
  for (const [name, validator] of Object.entries(validators)) {
    const options = { validator, validationLevel: "strict", validationAction: "error" };
    if (existing.includes(name)) {
      await db.command({ collMod: name, ...options });
    } else {
      await db.createCollection(name, options);
    }
  }
}

// Upgrades documents written by the first version of this project
// (single `available` flag, no authorId, no dueDate) to the current schema.
async function migrateOldDocuments(db) {
  const bypass = { bypassDocumentValidation: true };
  const books = db.collection("books");
  const authors = db.collection("authors");

  for (const book of await books.find({ authorId: { $exists: false } }).toArray()) {
    const author = await authors.findOneAndUpdate(
      { name: book.author },
      { $setOnInsert: { name: book.author, createdAt: new Date() } },
      { upsert: true, returnDocument: "after", collation: CASE_INSENSITIVE }
    );
    await books.updateOne({ _id: book._id }, { $set: { authorId: author._id } }, bypass);
  }

  await books.updateMany(
    { totalCopies: { $exists: false } },
    [
      { $set: {
          totalCopies: 1,
          availableCopies: { $cond: [{ $eq: ["$available", false] }, 0, 1] },
          borrowCount: { $toInt: { $ifNull: ["$borrowCount", 0] } },
          createdAt: { $ifNull: ["$createdAt", "$$NOW"] }
      }},
      { $unset: "available" }
    ],
    bypass
  );

  await books.updateMany({ heldCopies: { $exists: false } }, { $set: { heldCopies: 0 } }, bypass);

  await db.collection("loans").updateMany(
    { dueDate: { $exists: false } },
    [{ $set: { dueDate: { $dateAdd: { startDate: "$issuedAt", unit: "day", amount: LOAN_DAYS } } } }],
    bypass
  );

  await db.collection("borrowers").updateMany(
    { activeLoans: { $exists: false } },
    { $set: { activeLoans: 0 } },
    bypass
  );
}

// ---------------- INDEXING ----------------
async function createIndexes() {
  const { books, authors, borrowers, loans, reservations, payments, notifications, auditLogs } = collections;

  // Only one text index is allowed per collection, so drop the old
  // title+description one before creating the weighted title+author+description index.
  const bookIndexes = await books.indexes();
  for (const index of bookIndexes) {
    if (index.textIndexVersion && index.name !== "book_text_search") {
      await books.dropIndex(index.name);
    }
  }

  await books.createIndex({ title: 1 });
  await books.createIndex({ authorId: 1 });
  await books.createIndex({ borrowCount: -1 });
  await books.createIndex({ isbn: 1 }, { unique: true });
  await books.createIndex(
    { title: "text", author: "text", description: "text" },
    { name: "book_text_search", weights: { title: 10, author: 5, description: 1 } }
  );

  await authors.createIndex({ name: 1 }, { unique: true, collation: CASE_INSENSITIVE });
  await borrowers.createIndex({ email: 1 }, { unique: true });

  await loans.createIndex({ bookId: 1, returned: 1 });
  await loans.createIndex({ borrowerId: 1, issuedAt: -1 });
  await loans.createIndex({ returned: 1, dueDate: 1 });
  await loans.createIndex({ issuedAt: -1 });
  // Partial unique index: a borrower can't hold two copies of the same book at once
  await loans.createIndex(
    { bookId: 1, borrowerId: 1 },
    { unique: true, partialFilterExpression: { returned: false }, name: "one_active_loan_per_book" }
  );
  await loans.createIndex({ returned: 1, finePaid: 1, fine: 1 });

  // Reservation queue: oldest waiting reservation for a book comes first
  await reservations.createIndex({ bookId: 1, status: 1, createdAt: 1 });
  await reservations.createIndex({ status: 1, holdUntil: 1 });
  await reservations.createIndex(
    { bookId: 1, borrowerId: 1 },
    { unique: true, partialFilterExpression: { active: true }, name: "one_active_reservation_per_book" }
  );

  // One payment per fine
  await payments.createIndex({ loanId: 1 }, { unique: true });
  await payments.createIndex({ paidAt: -1 });

  await notifications.createIndex({ createdAt: -1 });
  await auditLogs.createIndex({ at: -1 });
  await auditLogs.createIndex({ entity: 1, at: -1 });
}

// Documents saved before the current rules existed stay in place, but strict
// validation will reject any update to them until they are fixed.
async function reportInvalidDocuments() {
  for (const [name, validator] of Object.entries(validators)) {
    const invalid = await collections[name].find({ $nor: [validator] }, { projection: { _id: 1 } }).toArray();
    if (invalid.length) {
      console.warn(`Warning: ${invalid.length} document(s) in "${name}" break the schema rules and can't be updated until fixed: ${invalid.map(d => d._id).join(", ")}`);
    }
  }
}

async function connect() {
  await client.connect();

  // Transactions need a replica set (or sharded cluster)
  const hello = await db.admin().command({ hello: 1 });
  state.transactionsSupported = Boolean(hello.setName || hello.msg === "isdbgrid");

  const existing = (await db.listCollections().toArray()).map(c => c.name);
  await migrateOldDocuments(db);
  await applyValidators(db, existing);
  await createIndexes();
  await reportInvalidDocuments();

  return db;
}

// Runs `work` inside a multi-document transaction. On a standalone server
// (no transactions) the steps registered with `onRollback` are undone by hand
// in reverse order if a later step fails.
async function runTransaction(work) {
  if (state.transactionsSupported) {
    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session, () => {});
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  const undo = [];
  try {
    return await work(undefined, step => undo.push(step));
  } catch (err) {
    for (const step of undo.reverse()) await step().catch(() => {});
    throw err;
  }
}

async function close() {
  await client.close();
}

module.exports = {
  client,
  db,
  connect,
  close,
  runTransaction,
  collections,
  state,
  DB_NAME,
  LOAN_DAYS,
  MAX_ACTIVE_LOANS,
  FINE_PER_DAY,
  HOLD_DAYS,
  REMINDER_DAYS_BEFORE,
  MAX_UNPAID_FINE,
  CASE_INSENSITIVE
};
