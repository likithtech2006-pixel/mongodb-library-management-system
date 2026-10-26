// npm test
// Starts the server against a throwaway database on the local MongoDB
// (override with TEST_MONGO_URI), runs every business rule end to end, then
// drops the database. Your real data is never touched.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MongoClient, ObjectId } = require("mongodb");

const ROOT = path.join(__dirname, "..");
const MONGO_URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017/?directConnection=true";
const DB_NAME = `library_test_${process.pid}_${Date.now()}`;
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://localhost:${PORT}/api`;
const DAY_MS = 24 * 60 * 60 * 1000;

let server, client, db, backupDir;

const env = () => ({
  ...process.env,
  MONGO_URI, DB_NAME, PORT: String(PORT),
  SCHEDULER: "off", MAX_UNPAID_FINE: "50", BACKUP_DIR: backupDir,
  SMTP_HOST: "", TWILIO_ACCOUNT_SID: ""
});

async function call(method, url, body, staff = "Test Runner") {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", "X-Staff-Name": staff },
    body: body && JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let seq = 0;
async function addBook(copies = 1) {
  seq++;
  // ISBN-13 shaped numbers that can't clash between tests
  const isbn = `979${String(Date.now()).slice(-6)}${String(seq).padStart(4, "0")}`;
  const r = await call("POST", "/books", { title: `Test Book ${seq}`, author: "Test Author", isbn, totalCopies: copies });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.book;
}

async function addBorrower(name = `Reader ${++seq}`) {
  const r = await call("POST", "/borrowers", { name, email: `${name.replace(/\s/g, ".").toLowerCase()}.${seq}@test.dev` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.borrower;
}

const issue = (book, borrower) => call("POST", "/loans/issue", { bookId: book._id, borrowerId: borrower._id });
const getBook = id => db.collection("books").findOne({ _id: new ObjectId(id) });

before(async () => {
  backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "library-backups-"));
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);

  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  server.stdout.on("data", d => { output += d; });
  server.stderr.on("data", d => { output += d; });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start:\n${output}`);
});

after(async () => {
  server?.kill();
  await db?.dropDatabase();
  await client?.close();
  if (backupDir) await fs.rm(backupDir, { recursive: true, force: true });
});

// ---------------- validation ----------------

test("rejects invalid ISBN, email and phone", async () => {
  assert.equal((await call("POST", "/books", { title: "X", author: "Y", isbn: "abc" })).status, 400);
  assert.equal((await call("POST", "/books", { title: "X", author: "Y", isbn: "9780134685991", totalCopies: 2.5 })).status, 400);
  assert.equal((await call("POST", "/borrowers", { name: "X", email: "not-an-email" })).status, 400);
  assert.equal((await call("POST", "/borrowers", { name: "X", email: "x@test.dev", phone: "12" })).status, 400);
});

test("database schema rejects documents the API would never write", async () => {
  await assert.rejects(
    db.collection("books").insertOne({ title: "Bad", author: "A", authorId: new ObjectId(), isbn: "123", totalCopies: 1, availableCopies: 5, heldCopies: 0, borrowCount: 0 }),
    err => err.code === 121
  );
});

test("duplicate ISBN and email get friendly messages", async () => {
  const book = await addBook();
  const dup = await call("POST", "/books", { title: "Copy", author: "Z", isbn: book.isbn });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /ISBN already exists/);

  const reader = await addBorrower();
  const dupReader = await call("POST", "/borrowers", { name: "Other", email: reader.email.toUpperCase() });
  assert.equal(dupReader.status, 409);
  assert.match(dupReader.body.error, /email/);
});

test("authors are matched case-insensitively", async () => {
  const a = await call("POST", "/books", { title: "One", author: "Ada Lovelace", isbn: "9780000000101" });
  const b = await call("POST", "/books", { title: "Two", author: "ada lovelace", isbn: "9780000000118" });
  assert.equal(b.body.book.authorId, a.body.book.authorId);
  assert.equal(b.body.book.author, "Ada Lovelace");
});

// ---------------- issue / return ----------------

test("six people racing for the last copy: exactly one wins", async () => {
  const book = await addBook(1);
  const readers = await Promise.all(Array.from({ length: 6 }, () => addBorrower()));
  const results = await Promise.all(readers.map(r => issue(book, r)));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.ok(results.filter(r => r.status !== 201).every(r => r.status === 409));

  const after = await getBook(book._id);
  assert.equal(after.availableCopies, 0);
  const activeLoans = await db.collection("borrowers").aggregate([
    { $match: { _id: { $in: readers.map(r => new ObjectId(r._id)) } } },
    { $group: { _id: null, total: { $sum: "$activeLoans" } } }
  ]).next();
  assert.equal(activeLoans.total, 1, "losing requests must leave no trace");
});

test("a borrower can hold at most 3 books", async () => {
  const reader = await addBorrower();
  for (let i = 0; i < 3; i++) assert.equal((await issue(await addBook(), reader)).status, 201);
  const fourth = await issue(await addBook(), reader);
  assert.equal(fourth.status, 409);
  assert.match(fourth.body.error, /maximum/);
});

test("books and borrowers with loans can't be deleted", async () => {
  const book = await addBook();
  const reader = await addBorrower();
  await issue(book, reader);
  assert.equal((await call("DELETE", `/books/${book._id}`)).status, 409);
  assert.equal((await call("DELETE", `/borrowers/${reader._id}`)).status, 409);
});

// ---------------- reservations ----------------

test("reservations: the returned copy is held for the first person in the queue", async () => {
  const book = await addBook(1);
  const [holder, first, second] = await Promise.all([addBorrower(), addBorrower(), addBorrower()]);

  // Can't reserve while a copy is on the shelf
  assert.equal((await call("POST", "/reservations", { bookId: book._id, borrowerId: first._id })).status, 409);

  const loan = (await issue(book, holder)).body.loan;
  assert.equal((await call("POST", "/reservations", { bookId: book._id, borrowerId: first._id })).status, 201);
  const r2 = await call("POST", "/reservations", { bookId: book._id, borrowerId: second._id });
  assert.equal(r2.body.reservation.position, 2);
  assert.equal((await call("POST", "/reservations", { bookId: book._id, borrowerId: second._id })).status, 409, "no duplicate reservations");

  const ret = await call("POST", "/loans/return", { loanId: loan._id });
  assert.equal(ret.body.heldForReservation, true);
  let b = await getBook(book._id);
  assert.deepEqual([b.availableCopies, b.heldCopies], [0, 1]);

  // The held copy is only for the first person
  assert.equal((await issue(book, second)).status, 409);
  assert.equal((await issue(book, first)).status, 201);

  const statuses = await db.collection("reservations").find({ bookId: new ObjectId(book._id) }).sort({ createdAt: 1 }).map(r => r.status).toArray();
  assert.deepEqual(statuses, ["fulfilled", "waiting"]);
  b = await getBook(book._id);
  assert.deepEqual([b.availableCopies, b.heldCopies], [0, 0]);

  // The notification outbox recorded the "ready" message
  assert.equal(await db.collection("notifications").countDocuments({ type: "reservation_ready", borrowerId: new ObjectId(first._id) }), 1);
});

test("cancelling a ready reservation passes the copy on, then back to the shelf", async () => {
  const book = await addBook(1);
  const [holder, first, second] = await Promise.all([addBorrower(), addBorrower(), addBorrower()]);
  const loan = (await issue(book, holder)).body.loan;
  const res1 = (await call("POST", "/reservations", { bookId: book._id, borrowerId: first._id })).body.reservation;
  const res2 = (await call("POST", "/reservations", { bookId: book._id, borrowerId: second._id })).body.reservation;
  await call("POST", "/loans/return", { loanId: loan._id });

  await call("DELETE", `/reservations/${res1._id}`);
  assert.equal((await db.collection("reservations").findOne({ _id: new ObjectId(res2._id) })).status, "ready");

  await call("DELETE", `/reservations/${res2._id}`);
  const b = await getBook(book._id);
  assert.deepEqual([b.availableCopies, b.heldCopies], [1, 0]);
});

// ---------------- fines ----------------

test("fines: calculated on return, paid once, and unpaid fines block borrowing", async () => {
  const book = await addBook(2);
  const reader = await addBorrower();
  const loan = (await issue(book, reader)).body.loan;

  assert.equal((await call("POST", `/loans/${loan._id}/pay`, { method: "cash" })).status, 409, "can't pay before return");

  // Pretend the book is 10 days late (any started day counts, so stay just under 10 full days)
  await db.collection("loans").updateOne(
    { _id: new ObjectId(loan._id) },
    { $set: { issuedAt: new Date(Date.now() - 24 * DAY_MS), dueDate: new Date(Date.now() - 10 * DAY_MS + 3600_000) } }
  );
  const ret = await call("POST", "/loans/return", { loanId: loan._id });
  assert.equal(ret.body.fine, 100);

  // ₹100 unpaid is over the test limit of ₹50
  const blocked = await issue(book, reader);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /unpaid fines/);

  assert.equal((await call("POST", `/loans/${loan._id}/pay`, { method: "bitcoin" })).status, 400);
  const paid = await call("POST", `/loans/${loan._id}/pay`, { method: "upi" });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.payment.amount, 100);
  assert.equal((await call("POST", `/loans/${loan._id}/pay`, { method: "upi" })).status, 409, "can't pay twice");

  assert.equal((await issue(book, reader)).status, 201, "borrowing allowed again after paying");
});

// ---------------- scan desk ----------------

test("scan desk: card + ISBN issues, the same scans again return", async () => {
  const book = await addBook();
  const reader = await addBorrower();
  const card = `MEMBER:${reader._id}`;
  const hyphenated = `${book.isbn.slice(0, 3)}-${book.isbn.slice(3)}`;

  const first = await call("POST", "/scan", { memberCode: card, bookCode: hyphenated });
  assert.equal(first.body.action, "issue");
  const second = await call("POST", "/scan", { memberCode: card, bookCode: book.isbn });
  assert.equal(second.body.action, "return");

  assert.equal((await call("POST", "/scan", { memberCode: book.isbn, bookCode: card })).status, 400, "card must come first");
  assert.equal((await call("GET", `/scan/resolve?code=${encodeURIComponent(reader.email)}`)).body.type, "borrower");
  const qr = await fetch(`${BASE}/qr/borrower/${reader._id}`);
  assert.match(qr.headers.get("content-type"), /svg/);
});

// ---------------- reminders ----------------

test("reminders: due-soon and overdue messages are sent once", async () => {
  const [soonBook, lateBook] = [await addBook(), await addBook()];
  const reader = await addBorrower();
  const soon = (await issue(soonBook, reader)).body.loan;
  const late = (await issue(lateBook, reader)).body.loan;
  const loansCol = db.collection("loans");
  await loansCol.updateOne({ _id: new ObjectId(soon._id) }, { $set: { dueDate: new Date(Date.now() + DAY_MS) } });
  await loansCol.updateOne({ _id: new ObjectId(late._id) }, { $set: { issuedAt: new Date(Date.now() - 20 * DAY_MS), dueDate: new Date(Date.now() - 2 * DAY_MS) } });

  const run1 = await call("POST", "/notifications/run");
  assert.ok(run1.body.dueSoon >= 1 && run1.body.overdue >= 1);
  const run2 = await call("POST", "/notifications/run");
  assert.deepEqual([run2.body.dueSoon, run2.body.overdue], [0, 0], "no duplicates");

  const sent = await db.collection("notifications").find({ borrowerId: new ObjectId(reader._id) }).toArray();
  assert.deepEqual(sent.map(n => n.type).sort(), ["due_soon", "overdue"]);
  assert.ok(sent.every(n => n.status === "logged"), "no SMTP configured, so messages are logged to the outbox");
});

// ---------------- backups ----------------

test("backup and restore round-trip every collection", async () => {
  const before = await db.collection("books").countDocuments();
  const made = await call("POST", "/backups");
  assert.equal(made.status, 201);
  const file = made.body.backup.file;
  assert.ok((await call("GET", "/backups")).body.files.some(f => f.file === file));
  assert.equal((await call("GET", "/backups/..%2F..%2Fetc%2Fpasswd")).status, 400, "path tricks rejected");

  await addBook(); // a change made after the backup
  await promisify(execFile)(process.execPath, ["scripts/restore.js", path.join(backupDir, file), "--force"], { cwd: ROOT, env: env() });
  assert.equal(await db.collection("books").countDocuments(), before, "restore brings back the backed-up state");
});

// ---------------- audit log and indexes ----------------

test("audit log records who did what", async () => {
  const book = await addBook();
  await call("DELETE", `/books/${book._id}`, undefined, "Priya");
  const entry = await db.collection("auditLogs").findOne({ action: "delete", entityId: new ObjectId(book._id) });
  assert.equal(entry.actor, "Priya");
  assert.match(entry.summary, /Deleted/);
});

test("text search uses the text index, regex scans the collection", async () => {
  const plan = (await call("GET", "/search/explain?q=Test")).body;
  assert.ok(plan.textIndex.indexes.includes("book_text_search"));
  assert.ok(plan.regexScan.stages.includes("COLLSCAN"));
});
