const { connect, close, collections, FINE_PER_DAY } = require("./db");

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(Date.now() - n * DAY_MS);

const bookData = [
  { title: "The C Programming Language", author: "Brian Kernighan", isbn: "9780131103627", copies: 2, description: "Programming and C language reference" },
  { title: "Clean Code", author: "Robert Martin", isbn: "9780132350884", copies: 3, description: "Software development and clean coding practices" },
  { title: "Computer Networks", author: "Andrew Tanenbaum", isbn: "9780132126953", copies: 2, description: "Networking concepts and protocols" },
  { title: "Modern Operating Systems", author: "Andrew Tanenbaum", isbn: "9780133591620", copies: 2, description: "Processes, memory management and file systems" },
  { title: "Database System Concepts", author: "Abraham Silberschatz", isbn: "9780078022159", copies: 3, description: "Database management systems and SQL" },
  { title: "Introduction to Algorithms", author: "Thomas Cormen", isbn: "9780262046305", copies: 4, description: "Algorithms and data structures" },
  { title: "The Pragmatic Programmer", author: "David Thomas", isbn: "9780135957059", copies: 2, description: "Practical advice for software developers" },
  { title: "MongoDB: The Definitive Guide", author: "Shannon Bradshaw", isbn: "9781491954461", copies: 2, description: "NoSQL document database design, indexing and aggregation" },
  { title: "Designing Data-Intensive Applications", author: "Martin Kleppmann", isbn: "9781449373320", copies: 1, description: "Distributed systems, replication and database internals" }
];

const borrowerData = [
  { name: "Arun", email: "arun@example.com", phone: "+919876543210" },
  { name: "Priya", email: "priya@example.com", phone: "+919812345678" },
  { name: "Rahul", email: "rahul@example.com" },
  { name: "Sneha", email: "sneha@example.com" },
  { name: "Karthik", email: "karthik@example.com" }
];

// [book index, borrower index, issued N days ago, loan days, returned after N days (null = still out), fine paid by]
const loanData = [
  [5, 0, 170, 14, 10], [1, 1, 165, 14, 12], [4, 2, 150, 14, 16], [5, 3, 140, 14, 9],
  [1, 4, 128, 14, 20, "cash"], [0, 0, 120, 14, 7], [2, 1, 110, 14, 14], [5, 2, 95, 14, 11],
  [3, 3, 90, 14, 18], [1, 0, 80, 14, 5], [7, 4, 70, 14, 13], [5, 1, 60, 14, 8],
  [4, 3, 52, 14, 15], [1, 2, 45, 14, 10], [8, 0, 40, 14, 21, "upi"], [2, 4, 35, 14, 6],
  [5, 4, 28, 14, 12], [3, 1, 22, 14, 9], [0, 2, 15, 14, 10],
  // still on loan - the middle three are overdue
  [1, 0, 3, 14, null], [5, 1, 20, 14, null], [2, 2, 25, 14, null],
  [7, 3, 10, 7, null], [8, 1, 5, 14, null]
];

// [book index, borrower index, reserved N days ago, status]
// Rahul and Sneha queue for the one copy of Designing Data-Intensive Applications;
// a returned copy of Computer Networks is being held for Karthik.
const reservationData = [
  [8, 2, 3, "waiting"], [8, 3, 1, "waiting"], [2, 4, 4, "ready"]
];

async function run() {
  await connect();
  const { authors, books, borrowers, loans, reservations, payments, notifications, auditLogs } = collections;

  const existing = await Promise.all([books, borrowers, loans, reservations].map(c => c.estimatedDocumentCount()));
  if (existing.some(n => n > 0) && !process.argv.includes("--force")) {
    console.log("The database already has data. Seeding would delete it.");
    console.log("Run `npm run seed -- --force` to wipe and reload the sample data.");
    process.exitCode = 1;
    return;
  }

  await Promise.all([authors, books, borrowers, loans, reservations, payments, notifications, auditLogs].map(c => c.deleteMany({})));

  const authorNames = [...new Set(bookData.map(b => b.author))];
  const authorResult = await authors.insertMany(authorNames.map(name => ({ name, createdAt: daysAgo(200) })));
  const authorIds = Object.fromEntries(authorNames.map((name, i) => [name, authorResult.insertedIds[i]]));

  const loanDocs = loanData.map(([book, borrower, issued, days, returnedAfter, paidBy]) => {
    const issuedAt = daysAgo(issued);
    const dueDate = new Date(issuedAt.getTime() + days * DAY_MS);
    const doc = { book, borrower, issuedAt, dueDate, returned: returnedAfter !== null };
    if (doc.returned) {
      doc.returnedAt = new Date(issuedAt.getTime() + returnedAfter * DAY_MS);
      doc.fine = Math.max(0, Math.ceil((doc.returnedAt - dueDate) / DAY_MS)) * FINE_PER_DAY;
      if (paidBy) {
        doc.finePaid = true;
        doc.finePaidAt = new Date(doc.returnedAt.getTime() + DAY_MS);
        doc.paidBy = paidBy;
      }
    }
    return doc;
  });
  const held = reservationData.filter(r => r[3] === "ready");
  const activeLoans = loanDocs.filter(l => !l.returned);
  const count = (list, key, i) => list.filter(l => l[key] === i).length;

  const bookResult = await books.insertMany(bookData.map((b, i) => ({
    title: b.title,
    author: b.author,
    authorId: authorIds[b.author],
    description: b.description,
    isbn: b.isbn,
    totalCopies: b.copies,
    availableCopies: b.copies - count(activeLoans, "book", i) - count(held.map(r => ({ book: r[0] })), "book", i),
    heldCopies: count(held.map(r => ({ book: r[0] })), "book", i),
    borrowCount: count(loanDocs, "book", i),
    createdAt: daysAgo(200 - i * 5)
  })));

  const borrowerResult = await borrowers.insertMany(borrowerData.map((b, i) => ({
    ...b,
    activeLoans: count(activeLoans, "borrower", i),
    createdAt: daysAgo(190)
  })));

  const loanResult = await loans.insertMany(loanDocs.map(({ book, borrower, paidBy, ...rest }) => ({
    bookId: bookResult.insertedIds[book],
    borrowerId: borrowerResult.insertedIds[borrower],
    ...rest
  })));

  const paid = loanDocs.map((l, i) => ({ ...l, _id: loanResult.insertedIds[i] })).filter(l => l.paidBy);
  if (paid.length) {
    await payments.insertMany(paid.map(l => ({
      loanId: l._id,
      borrowerId: borrowerResult.insertedIds[l.borrower],
      amount: l.fine,
      method: l.paidBy,
      paidAt: l.finePaidAt,
      receivedBy: "Librarian"
    })));
  }

  await reservations.insertMany(reservationData.map(([book, borrower, ago, status]) => {
    const createdAt = daysAgo(ago);
    const doc = { bookId: bookResult.insertedIds[book], borrowerId: borrowerResult.insertedIds[borrower], status, active: true, createdAt };
    if (status === "ready") {
      doc.readyAt = daysAgo(1);
      doc.holdUntil = new Date(doc.readyAt.getTime() + 3 * DAY_MS);
    }
    return doc;
  }));

  await auditLogs.insertOne({ at: new Date(), action: "seed", entity: "system", summary: "Loaded the sample data (seed.js)", actor: "System" });

  console.log(`Seeded ${authorNames.length} authors, ${bookData.length} books, ${borrowerData.length} borrowers, ${loanDocs.length} loans (${activeLoans.length} still out), ${reservationData.length} reservations, ${paid.length} fine payments.`);
}

run()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(close);
