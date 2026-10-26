const express = require("express");
const path = require("path");
const {
  connect, close, runTransaction, collections, state,
  DB_NAME, LOAN_DAYS, MAX_ACTIVE_LOANS, FINE_PER_DAY, HOLD_DAYS, MAX_UNPAID_FINE, CASE_INSENSITIVE
} = require("./db");
const {
  HttpError, isBlank, text, integer, isbnOf, emailOf, phoneOf, idOf, escapeRegex
} = require("./lib/validate");
const { audit } = require("./lib/audit");
const { channels } = require("./lib/notify");
const { overdueDays, issueLoan, returnLoan } = require("./lib/circulation");
const { startScheduler, schedule } = require("./lib/scheduler");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const { books, authors, borrowers, loans, reservations, payments } = collections;

app.use(express.json());
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use(express.static(path.join(__dirname, "public")));

// Connect once. On Vercel the first request after a cold start waits for this.
const ready = connect();
ready.catch(err => console.error("Could not connect to MongoDB:", err.message));
app.use("/api", async (req, res, next) => {
  await ready;
  next();
});

async function findOrCreateAuthor(name, session, onRollback) {
  const result = await authors.findOneAndUpdate(
    { name },
    { $setOnInsert: { name, createdAt: new Date() } },
    { upsert: true, returnDocument: "after", collation: CASE_INSENSITIVE, includeResultMetadata: true, session }
  );
  if (result.lastErrorObject?.upserted) {
    onRollback(() => authors.deleteOne({ _id: result.value._id }));
  }
  return result.value;
}

// ---------------- BOOKS ----------------

// 1. Add Book (author is found or created in the same transaction)
app.post("/api/books", async (req, res) => {
  const title = text(req.body.title, "Title", { required: true });
  const authorName = text(req.body.author, "Author", { required: true, max: 100 });
  const description = text(req.body.description, "Description", { max: 2000 }) || "";
  const isbn = isbnOf(req.body.isbn, true);
  const totalCopies = integer(req.body.totalCopies, "Copies", 1, 1000, 1);

  const book = await runTransaction(async (session, onRollback) => {
    const author = await findOrCreateAuthor(authorName, session, onRollback);
    const doc = {
      title,
      author: author.name,
      authorId: author._id,
      description,
      isbn,
      totalCopies,
      availableCopies: totalCopies,
      heldCopies: 0,
      borrowCount: 0,
      createdAt: new Date()
    };
    const result = await books.insertOne(doc, { session });
    await audit(req, { action: "create", entity: "book", entityId: result.insertedId, summary: `Added "${title}" by ${author.name} (${totalCopies} ${totalCopies === 1 ? "copy" : "copies"})` }, session);
    return { _id: result.insertedId, ...doc };
  });

  res.status(201).json({ message: "Book added successfully.", book });
});

// 5. View Books - filtering, sorting and pagination in one $facet query
app.get("/api/books", async (req, res) => {
  const page = integer(req.query.page, "Page", 1, 100000, 1);
  const limit = integer(req.query.limit, "Limit", 1, 50, 8);

  const match = {};
  if (req.query.status === "available") match.availableCopies = { $gt: 0 };
  if (req.query.status === "out") match.availableCopies = 0;

  const sorts = {
    title: { title: 1 },
    popular: { borrowCount: -1, title: 1 },
    newest: { createdAt: -1, _id: -1 }
  };
  const sort = sorts[req.query.sort] || sorts.title;

  const [result] = await books.aggregate([
    { $match: match },
    { $facet: {
        items: [{ $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "count" }]
    }}
  ]).toArray();

  const total = result.total[0]?.count || 0;
  res.json({ items: result.items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

// Lightweight list for dropdowns
app.get("/api/books/options", async (req, res) => {
  res.json(await books
    .find({}, { projection: { title: 1, author: 1, availableCopies: 1, heldCopies: 1, totalCopies: 1 } })
    .sort({ title: 1 })
    .toArray());
});

// CRUD: Update book
app.put("/api/books/:id", async (req, res) => {
  const id = idOf(req.params.id, "book");
  const fields = {};
  const title = text(req.body.title, "Title");
  if (title) fields.title = title;
  if (req.body.description !== undefined) {
    fields.description = text(req.body.description, "Description", { max: 2000 }) || "";
  }
  const isbn = isbnOf(req.body.isbn);
  if (isbn) fields.isbn = isbn;
  const authorName = text(req.body.author, "Author", { max: 100 });
  const totalCopies = isBlank(req.body.totalCopies) ? undefined : integer(req.body.totalCopies, "Copies", 1, 1000);

  if (!Object.keys(fields).length && !authorName && totalCopies === undefined) {
    throw new HttpError(400, "No fields to update.");
  }

  await runTransaction(async (session, onRollback) => {
    const book = await books.findOne({ _id: id }, { session });
    if (!book) throw new HttpError(404, "Book not found.");

    if (authorName) {
      const author = await findOrCreateAuthor(authorName, session, onRollback);
      fields.author = author.name;
      fields.authorId = author._id;
    }

    // Matching on the old totalCopies makes this an optimistic-locking update
    const filter = { _id: id, totalCopies: book.totalCopies };
    const change = {};
    if (Object.keys(fields).length) change.$set = fields;

    if (totalCopies !== undefined && totalCopies !== book.totalCopies) {
      const inUse = book.totalCopies - book.availableCopies;
      if (totalCopies < inUse) {
        throw new HttpError(409, `${inUse} copies are on loan or held for reservations, so the total can't go below ${inUse}.`);
      }
      const diff = totalCopies - book.totalCopies;
      filter.availableCopies = { $gte: -diff };
      change.$inc = { totalCopies: diff, availableCopies: diff };
    }

    if (!change.$set && !change.$inc) return;
    const result = await books.updateOne(filter, change, { session });
    if (!result.matchedCount) {
      throw new HttpError(409, "The book changed while you were editing it. Please try again.");
    }
    const changed = [...Object.keys(fields).filter(k => k !== "authorId"), ...(change.$inc ? ["totalCopies"] : [])];
    await audit(req, { action: "update", entity: "book", entityId: id, summary: `Edited "${fields.title ?? book.title}" (${changed.join(", ")})` }, session);
  });

  res.json({ message: "Book updated successfully." });
});

// CRUD: Delete book (only when every copy is on the shelf)
app.delete("/api/books/:id", async (req, res) => {
  const id = idOf(req.params.id, "book");
  if (await reservations.countDocuments({ bookId: id, active: true })) {
    throw new HttpError(409, "This book has people waiting for it. Cancel its reservations first.");
  }
  const book = await books.findOneAndDelete({ _id: id, $expr: { $eq: ["$availableCopies", "$totalCopies"] } });
  if (!book) {
    if (!(await books.countDocuments({ _id: id }))) throw new HttpError(404, "Book not found.");
    throw new HttpError(409, "Can't delete this book while copies are on loan.");
  }
  await audit(req, { action: "delete", entity: "book", entityId: id, summary: `Deleted "${book.title}"` });
  res.json({ message: "Book deleted successfully." });
});

// ---------------- AUTHORS ----------------

app.get("/api/authors", async (req, res) => {
  res.json(await authors.aggregate([
    { $lookup: { from: "books", localField: "_id", foreignField: "authorId", as: "books" } },
    { $project: {
        name: 1,
        bookCount: { $size: "$books" },
        totalBorrows: { $sum: "$books.borrowCount" }
    }},
    { $sort: { name: 1 } }
  ], { collation: { locale: "en" } }).toArray());
});

app.delete("/api/authors/:id", async (req, res) => {
  const id = idOf(req.params.id, "author");
  if (await books.countDocuments({ authorId: id })) {
    throw new HttpError(409, "This author still has books. Delete or reassign them first.");
  }
  const author = await authors.findOneAndDelete({ _id: id });
  if (!author) throw new HttpError(404, "Author not found.");
  await audit(req, { action: "delete", entity: "author", entityId: id, summary: `Deleted author ${author.name}` });
  res.json({ message: "Author deleted successfully." });
});

// ---------------- BORROWERS ----------------

// 2. Register Borrower
app.post("/api/borrowers", async (req, res) => {
  const phone = phoneOf(req.body.phone);
  const doc = {
    name: text(req.body.name, "Name", { required: true, max: 100 }),
    email: emailOf(req.body.email, true),
    ...(phone && { phone }),
    activeLoans: 0,
    createdAt: new Date()
  };
  const result = await borrowers.insertOne(doc);
  await audit(req, { action: "create", entity: "borrower", entityId: result.insertedId, summary: `Registered ${doc.name} (${doc.email})` });
  res.status(201).json({ message: "Borrower registered successfully.", borrower: { _id: result.insertedId, ...doc } });
});

app.get("/api/borrowers", async (req, res) => {
  res.json(await borrowers.find({}).sort({ name: 1 }).toArray());
});

// CRUD: Update borrower
app.put("/api/borrowers/:id", async (req, res) => {
  const id = idOf(req.params.id, "borrower");
  const update = {};
  const name = text(req.body.name, "Name", { max: 100 });
  if (name) update.name = name;
  const email = emailOf(req.body.email);
  if (email) update.email = email;
  // An empty phone field removes the number
  const clearPhone = req.body.phone !== undefined && isBlank(req.body.phone);
  const phone = clearPhone ? undefined : phoneOf(req.body.phone);
  if (phone) update.phone = phone;
  if (!Object.keys(update).length && !clearPhone) throw new HttpError(400, "No fields to update.");

  const change = { ...(Object.keys(update).length && { $set: update }), ...(clearPhone && { $unset: { phone: "" } }) };
  const borrower = await borrowers.findOneAndUpdate({ _id: id }, change, { returnDocument: "after" });
  if (!borrower) throw new HttpError(404, "Borrower not found.");
  await audit(req, { action: "update", entity: "borrower", entityId: id, summary: `Edited ${borrower.name} (${[...Object.keys(update), ...(clearPhone ? ["phone removed"] : [])].join(", ")})` });
  res.json({ message: "Borrower updated successfully." });
});

// CRUD: Delete borrower (only with no books on loan)
app.delete("/api/borrowers/:id", async (req, res) => {
  const id = idOf(req.params.id, "borrower");
  if (await reservations.countDocuments({ borrowerId: id, active: true })) {
    throw new HttpError(409, "This borrower has active reservations. Cancel them first.");
  }
  const borrower = await borrowers.findOneAndDelete({ _id: id, activeLoans: 0 });
  if (!borrower) {
    if (!(await borrowers.countDocuments({ _id: id }))) throw new HttpError(404, "Borrower not found.");
    throw new HttpError(409, "This borrower still has books on loan.");
  }
  await audit(req, { action: "delete", entity: "borrower", entityId: id, summary: `Deleted ${borrower.name} (${borrower.email})` });
  res.json({ message: "Borrower deleted successfully." });
});

// Borrower loan history ($lookup join)
app.get("/api/borrowers/:id/loans", async (req, res) => {
  const id = idOf(req.params.id, "borrower");
  const borrower = await borrowers.findOne({ _id: id });
  if (!borrower) throw new HttpError(404, "Borrower not found.");

  const history = await loans.aggregate([
    { $match: { borrowerId: id } },
    { $sort: { issuedAt: -1 } },
    { $lookup: { from: "books", localField: "bookId", foreignField: "_id", as: "book" } },
    { $project: {
        issuedAt: 1, dueDate: 1, returnedAt: 1, returned: 1, finePaid: 1, finePaidAt: 1,
        bookTitle: { $ifNull: [{ $first: "$book.title" }, "(deleted book)"] },
        overdue: { $and: [{ $not: ["$returned"] }, { $lt: ["$dueDate", "$$NOW"] }] },
        fine: { $cond: [
          "$returned",
          { $ifNull: ["$fine", 0] },
          { $multiply: [overdueDays("$$NOW"), FINE_PER_DAY] }
        ]}
    }}
  ]).toArray();

  res.json({ borrower, loans: history });
});

// ---------------- LOANS ----------------

// 3. Issue Book - several writes that must all succeed or all fail (see lib/circulation.js)
app.post("/api/loans/issue", async (req, res) => {
  const loan = await issueLoan({
    bookId: idOf(req.body.bookId, "book"),
    borrowerId: idOf(req.body.borrowerId, "borrower"),
    days: integer(req.body.days, "Loan period", 1, 60, LOAN_DAYS),
    req
  });
  res.status(201).json({
    message: `"${loan.bookTitle}" issued to ${loan.borrowerName}, due ${loan.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.`,
    loan
  });
});

// 4. Return Book - the fine is calculated by MongoDB; the copy goes to the reservation queue first
app.post("/api/loans/return", async (req, res) => {
  const { loan, reservation } = await returnLoan(idOf(req.body.loanId, "loan"), req);
  const held = reservation ? " The copy is now held for the next reservation." : "";
  res.json({
    message: (loan.fine > 0 ? `Book returned late. Fine: ₹${loan.fine}.` : "Book returned on time.") + held,
    fine: loan.fine,
    heldForReservation: Boolean(reservation)
  });
});

function activeLoansPipeline(match = {}) {
  return [
    { $match: { returned: false, ...match } },
    { $sort: { dueDate: 1 } },
    { $lookup: { from: "books", localField: "bookId", foreignField: "_id", as: "book" } },
    { $lookup: { from: "borrowers", localField: "borrowerId", foreignField: "_id", as: "borrower" } },
    { $unwind: "$book" },
    { $unwind: "$borrower" },
    { $project: {
        bookId: 1,
        borrowerId: 1,
        issuedAt: 1,
        dueDate: 1,
        bookTitle: "$book.title",
        borrowerName: "$borrower.name",
        borrowerEmail: "$borrower.email",
        overdue: { $lt: ["$dueDate", "$$NOW"] },
        overdueDays: overdueDays("$$NOW"),
        fine: { $multiply: [overdueDays("$$NOW"), FINE_PER_DAY] }
    }}
  ];
}

app.get("/api/loans/active", async (req, res) => {
  res.json(await loans.aggregate(activeLoansPipeline()).toArray());
});

// Overdue loans with running fines
app.get("/api/loans/overdue", async (req, res) => {
  const data = await loans.aggregate([
    ...activeLoansPipeline({ dueDate: { $lt: new Date() } }),
    { $sort: { overdueDays: -1 } }
  ]).toArray();
  res.json({
    count: data.length,
    totalFines: data.reduce((sum, l) => sum + l.fine, 0),
    finePerDay: FINE_PER_DAY,
    loans: data
  });
});

// ---------------- TEXT SEARCH & INDEXING ----------------

app.get("/api/search", async (req, res) => {
  const q = text(req.query.q, "Search", { max: 100 });
  if (!q) return res.json([]);

  const results = await books
    .find({ $text: { $search: q } }, { projection: { score: { $meta: "textScore" } } })
    .sort({ score: { $meta: "textScore" } })
    .limit(50)
    .toArray();
  res.json(results);
});

function summarizePlan(explain) {
  const stages = [];
  const indexes = new Set();
  (function walk(node) {
    if (!node) return;
    stages.push(node.stage);
    if (node.indexName) indexes.add(node.indexName);
    walk(node.inputStage);
    (node.inputStages || []).forEach(walk);
  })(explain.queryPlanner.winningPlan.queryPlan || explain.queryPlanner.winningPlan);

  const stats = explain.executionStats;
  return {
    stages,
    indexes: [...indexes],
    returned: stats.nReturned,
    keysExamined: stats.totalKeysExamined,
    docsExamined: stats.totalDocsExamined,
    timeMs: stats.executionTimeMillis
  };
}

// explain(): the same search with the text index vs. a regex that scans every document
app.get("/api/search/explain", async (req, res) => {
  const q = text(req.query.q, "Search", { required: true, max: 100 });
  const regex = new RegExp(escapeRegex(q), "i");

  const [indexed, scan] = await Promise.all([
    books.find({ $text: { $search: q } }).explain("executionStats"),
    books.find({ $or: [{ title: regex }, { author: regex }, { description: regex }] }).explain("executionStats")
  ]);
  const totalDocuments = await books.estimatedDocumentCount();

  res.json({ totalDocuments, textIndex: summarizePlan(indexed), regexScan: summarizePlan(scan) });
});

// ---------------- AGGREGATION & ANALYTICS ----------------

function lastMonths(count) {
  const now = new Date();
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}

app.get("/api/analytics", async (req, res) => {
  const months = lastMonths(6);

  const [bookStats] = await books.aggregate([
    { $facet: {
        totals: [{ $group: {
          _id: null,
          titles: { $sum: 1 },
          copies: { $sum: "$totalCopies" },
          available: { $sum: "$availableCopies" },
          held: { $sum: "$heldCopies" }
        }}],
        mostBorrowed: [
          { $sort: { borrowCount: -1, title: 1 } },
          { $limit: 5 },
          { $project: { title: 1, author: 1, borrowCount: 1 } }
        ],
        topAuthors: [
          { $group: { _id: "$authorId", name: { $first: "$author" }, borrows: { $sum: "$borrowCount" }, titles: { $sum: 1 } } },
          { $sort: { borrows: -1, name: 1 } },
          { $limit: 5 }
        ],
        popularity: [
          { $bucket: { groupBy: "$borrowCount", boundaries: [0, 1, 5, 10], default: "10+", output: { count: { $sum: 1 } } } }
        ]
    }}
  ]).toArray();

  const [loanStats] = await loans.aggregate([
    { $facet: {
        status: [{ $group: {
          _id: null,
          active: { $sum: { $cond: ["$returned", 0, 1] } },
          overdue: { $sum: { $cond: [{ $and: [{ $not: ["$returned"] }, { $lt: ["$dueDate", "$$NOW"] }] }, 1, 0] } },
          finesCharged: { $sum: { $ifNull: ["$fine", 0] } },
          finesOutstanding: { $sum: { $cond: [{ $and: ["$returned", { $ne: ["$finePaid", true] }] }, { $ifNull: ["$fine", 0] }, 0] } }
        }}],
        perMonth: [
          { $match: { issuedAt: { $gte: new Date(`${months[0]}-01T00:00:00Z`) } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$issuedAt" } }, loans: { $sum: 1 } } }
        ]
    }}
  ]).toArray();

  const [[paid], waiting] = await Promise.all([
    payments.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray(),
    reservations.countDocuments({ status: "waiting" })
  ]);

  const activeBorrowers = await borrowers.aggregate([
    { $match: { activeLoans: { $gt: 0 } } },
    { $sort: { activeLoans: -1, name: 1 } },
    { $project: { name: 1, email: 1, activeLoans: 1 } }
  ]).toArray();

  const bucketLabels = { 0: "Never borrowed", 1: "1–4 loans", 5: "5–9 loans", "10+": "10+ loans" };
  const monthCounts = Object.fromEntries(loanStats.perMonth.map(m => [m._id, m.loans]));

  res.json({
    totals: bookStats.totals[0] || { titles: 0, copies: 0, available: 0, held: 0 },
    loans: {
      ...(loanStats.status[0] || { active: 0, overdue: 0, finesCharged: 0, finesOutstanding: 0 }),
      finesCollected: paid?.total || 0
    },
    reservationsWaiting: waiting,
    mostBorrowed: bookStats.mostBorrowed,
    topAuthors: bookStats.topAuthors,
    popularity: bookStats.popularity.map(b => ({ label: bucketLabels[b._id], count: b.count })),
    loansPerMonth: months.map(month => ({ month, loans: monthCounts[month] || 0 })),
    activeBorrowers
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    database: DB_NAME,
    transactions: state.transactionsSupported,
    rules: { loanDays: LOAN_DAYS, maxActiveLoans: MAX_ACTIVE_LOANS, finePerDay: FINE_PER_DAY, holdDays: HOLD_DAYS, maxUnpaidFine: MAX_UNPAID_FINE },
    channels,
    schedule
  });
});

require("./routes/reservations")(app);
require("./routes/fines")(app);
require("./routes/scan")(app);
require("./routes/system")(app);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------- ERROR HANDLING ----------------

function duplicateMessage(err) {
  if (/one_active_reservation_per_book/.test(err.message)) return "This borrower has already reserved this book.";
  if (/payments/.test(err.message)) return "This fine has already been paid.";
  const keys = Object.keys(err.keyPattern || err.keyValue || {}).sort().join(",");
  const messages = {
    isbn: "A book with this ISBN already exists.",
    email: "A borrower with this email is already registered.",
    name: "An author with this name already exists.",
    "bookId,borrowerId": "This borrower already has a copy of this book."
  };
  return messages[keys] || "This record already exists.";
}

function failedFields(node, out = new Set()) {
  if (Array.isArray(node)) {
    node.forEach(n => failedFields(n, out));
  } else if (node && typeof node === "object") {
    if (node.propertyName) out.add(node.propertyName);
    Object.values(node).forEach(v => failedFields(v, out));
  }
  return out;
}

// Express 5 forwards errors thrown in async route handlers here
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
  if (err.code === 11000) return res.status(409).json({ error: duplicateMessage(err) });
  if (err.code === 121) {
    const fields = [...failedFields(err.errInfo)];
    return res.status(400).json({
      error: fields.length
        ? `MongoDB schema validation rejected: ${fields.join(", ")}.`
        : "MongoDB schema validation rejected this document."
    });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

// Vercel imports the app and runs it as a serverless function; locally we listen on a port
module.exports = app;

if (!process.env.VERCEL) ready
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Connected to MongoDB: ${DB_NAME} (transactions ${state.transactionsSupported ? "on" : "off - standalone server"})`);
      console.log(`Website running at http://localhost:${PORT}`);
    });

    const stopScheduler = startScheduler();

    const shutdown = signal => {
      console.log(`${signal} received, closing...`);
      stopScheduler();
      server.closeAllConnections();
      server.close(async () => {
        await close();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch(err => {
    console.error("Could not start application:", err.message);
    process.exit(1);
  });
