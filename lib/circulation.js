const {
  runTransaction, collections, FINE_PER_DAY, HOLD_DAYS, MAX_ACTIVE_LOANS, MAX_UNPAID_FINE
} = require("../db");
const { HttpError, formatDate } = require("./validate");
const { audit, actorOf } = require("./audit");
const { notifyBorrower } = require("./notify");

const { books, borrowers, loans, reservations, payments } = collections;
const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days a loan is past its due date at `end` (0 if not overdue)
function overdueDays(end) {
  return { $max: [0, { $ceil: { $divide: [{ $subtract: [end, "$dueDate"] }, DAY_MS] } }] };
}

async function unpaidFines(borrowerId, session) {
  const [row] = await loans.aggregate([
    { $match: { borrowerId, returned: true, fine: { $gt: 0 }, finePaid: { $ne: true } } },
    { $group: { _id: null, total: { $sum: "$fine" } } }
  ], { session }).toArray();
  return row?.total || 0;
}

// Moves the oldest waiting reservation for a book to "ready" and starts its hold
async function readyNextReservation(bookId, session, onRollback) {
  const now = new Date();
  const next = await reservations.findOneAndUpdate(
    { bookId, status: "waiting" },
    { $set: { status: "ready", readyAt: now, holdUntil: new Date(now.getTime() + HOLD_DAYS * DAY_MS) } },
    { sort: { createdAt: 1 }, session, returnDocument: "after" }
  );
  if (next) {
    onRollback(() => reservations.updateOne({ _id: next._id }, { $set: { status: "waiting" }, $unset: { readyAt: "", holdUntil: "" } }));
  }
  return next;
}

// A returned copy goes to the first person in the reservation queue (held for
// them), otherwise back on the shelf
async function placeReturnedCopy(bookId, session, onRollback) {
  const next = await readyNextReservation(bookId, session, onRollback);
  const field = next ? "heldCopies" : "availableCopies";
  await books.updateOne({ _id: bookId }, { $inc: { [field]: 1 } }, { session });
  onRollback(() => books.updateOne({ _id: bookId }, { $inc: { [field]: -1 } }));
  return next;
}

// A held copy whose reservation ended (cancelled or expired) is passed to the
// next person waiting, otherwise it goes back on the shelf
async function releaseHeldCopy(bookId, session, onRollback) {
  const next = await readyNextReservation(bookId, session, onRollback);
  if (next) return next;
  await books.updateOne({ _id: bookId, heldCopies: { $gt: 0 } }, { $inc: { heldCopies: -1, availableCopies: 1 } }, { session });
  onRollback(() => books.updateOne({ _id: bookId }, { $inc: { heldCopies: 1, availableCopies: -1 } }));
  return null;
}

async function notifyReservationReady(reservation) {
  const [book, borrower] = await Promise.all([
    books.findOne({ _id: reservation.bookId }, { projection: { title: 1 } }),
    borrowers.findOne({ _id: reservation.borrowerId })
  ]);
  if (!book || !borrower) return;
  await notifyBorrower(borrower, {
    type: "reservation_ready",
    reservationId: reservation._id,
    subject: `"${book.title}" is ready for you`,
    body: `Hi ${borrower.name}, the book you reserved, "${book.title}", is back. We'll hold it for you until ${formatDate(reservation.holdUntil)}.`
  });
}

// ---------------- ISSUE ----------------

async function issueLoan({ bookId, borrowerId, days, req }) {
  const now = new Date();
  return runTransaction(async (session, onRollback) => {
    const owed = await unpaidFines(borrowerId, session);
    if (owed > MAX_UNPAID_FINE) {
      throw new HttpError(409, `This borrower owes ₹${owed} in unpaid fines (limit ₹${MAX_UNPAID_FINE}). Record the payment first.`);
    }

    // A copy held for this borrower's reservation comes first
    const reservation = await reservations.findOneAndUpdate(
      { bookId, borrowerId, status: "ready" },
      { $set: { status: "fulfilled", active: false, closedAt: now } },
      { session }
    );
    let book;
    if (reservation) {
      onRollback(() => reservations.updateOne({ _id: reservation._id }, { $set: { status: "ready", active: true }, $unset: { closedAt: "" } }));
      book = await books.findOneAndUpdate(
        { _id: bookId, heldCopies: { $gt: 0 } },
        { $inc: { heldCopies: -1, borrowCount: 1 } },
        { session, returnDocument: "after" }
      );
      if (!book) throw new HttpError(409, "The copy held for this reservation is no longer available.");
      onRollback(() => books.updateOne({ _id: bookId }, { $inc: { heldCopies: 1, borrowCount: -1 } }));
    } else {
      // Atomic check-and-update: only matches if a copy is on the shelf
      book = await books.findOneAndUpdate(
        { _id: bookId, availableCopies: { $gt: 0 } },
        { $inc: { availableCopies: -1, borrowCount: 1 } },
        { session, returnDocument: "after" }
      );
      if (!book) {
        const existing = await books.findOne({ _id: bookId }, { session });
        if (!existing) throw new HttpError(404, "Book not found.");
        throw new HttpError(409, existing.heldCopies > 0
          ? "The remaining copies are held for reservations. Reserve it to join the queue."
          : "No copies of this book are on the shelf. Reserve it to join the queue.");
      }
      onRollback(() => books.updateOne({ _id: bookId }, { $inc: { availableCopies: 1, borrowCount: -1 } }));

      // Getting a shelf copy also completes this borrower's own waiting reservation
      const waiting = await reservations.findOneAndUpdate(
        { bookId, borrowerId, status: "waiting" },
        { $set: { status: "fulfilled", active: false, closedAt: now } },
        { session }
      );
      if (waiting) onRollback(() => reservations.updateOne({ _id: waiting._id }, { $set: { status: "waiting", active: true }, $unset: { closedAt: "" } }));
    }

    // Atomic borrowing limit
    const borrower = await borrowers.findOneAndUpdate(
      { _id: borrowerId, activeLoans: { $lt: MAX_ACTIVE_LOANS } },
      { $inc: { activeLoans: 1 } },
      { session, returnDocument: "after" }
    );
    if (!borrower) {
      if (!(await borrowers.countDocuments({ _id: borrowerId }, { session }))) throw new HttpError(404, "Borrower not found.");
      throw new HttpError(409, `This borrower already has ${MAX_ACTIVE_LOANS} books, the maximum allowed.`);
    }
    onRollback(() => borrowers.updateOne({ _id: borrowerId }, { $inc: { activeLoans: -1 } }));

    const doc = {
      bookId,
      borrowerId,
      issuedAt: now,
      dueDate: new Date(now.getTime() + days * DAY_MS),
      returned: false
    };
    const result = await loans.insertOne(doc, { session });
    onRollback(() => loans.deleteOne({ _id: result.insertedId }));

    await audit(req, {
      action: "issue", entity: "loan", entityId: result.insertedId,
      summary: `Issued "${book.title}" to ${borrower.name}, due ${formatDate(doc.dueDate)}${reservation ? " (reserved copy)" : ""}`
    }, session);

    return { _id: result.insertedId, ...doc, bookTitle: book.title, borrowerName: borrower.name, fromReservation: Boolean(reservation) };
  });
}

// ---------------- RETURN ----------------

// The fine is calculated by MongoDB in a pipeline update, using its own clock ($$NOW)
async function returnLoan(loanId, req) {
  const outcome = await runTransaction(async (session, onRollback) => {
    const loan = await loans.findOneAndUpdate(
      { _id: loanId, returned: false },
      [{ $set: {
          returned: true,
          returnedAt: "$$NOW",
          fine: { $multiply: [overdueDays("$$NOW"), FINE_PER_DAY] }
      }}],
      { session, returnDocument: "after" }
    );
    if (!loan) {
      if (!(await loans.countDocuments({ _id: loanId }, { session }))) throw new HttpError(404, "Loan not found.");
      throw new HttpError(409, "This book has already been returned.");
    }
    onRollback(() => loans.updateOne({ _id: loanId }, { $set: { returned: false }, $unset: { returnedAt: "", fine: "" } }));

    const reservation = await placeReturnedCopy(loan.bookId, session, onRollback);

    const borrower = await borrowers.findOneAndUpdate(
      { _id: loan.borrowerId, activeLoans: { $gt: 0 } },
      { $inc: { activeLoans: -1 } },
      { session, returnDocument: "after" }
    );
    const book = await books.findOne({ _id: loan.bookId }, { session, projection: { title: 1 } });

    await audit(req, {
      action: "return", entity: "loan", entityId: loanId,
      summary: `"${book?.title}" returned by ${borrower?.name ?? "a deleted borrower"}`
        + (loan.fine > 0 ? `, fine ₹${loan.fine}` : "")
        + (reservation ? "; copy held for the next reservation" : "")
    }, session);

    return { loan, reservation, bookTitle: book?.title };
  });

  if (outcome.reservation) await notifyReservationReady(outcome.reservation).catch(err => console.error("Notify failed:", err.message));
  return outcome;
}

// ---------------- RESERVATIONS ----------------

async function createReservation({ bookId, borrowerId, req }) {
  const [book, borrower] = await Promise.all([books.findOne({ _id: bookId }), borrowers.findOne({ _id: borrowerId })]);
  if (!book) throw new HttpError(404, "Book not found.");
  if (!borrower) throw new HttpError(404, "Borrower not found.");
  if (book.availableCopies > 0) {
    throw new HttpError(409, "Copies are on the shelf right now, so issue it instead of reserving.");
  }
  if (await loans.countDocuments({ bookId, borrowerId, returned: false })) {
    throw new HttpError(409, "This borrower already has this book on loan.");
  }

  const doc = { bookId, borrowerId, status: "waiting", active: true, createdAt: new Date() };
  const result = await reservations.insertOne(doc);
  const position = await reservations.countDocuments({ bookId, status: "waiting", createdAt: { $lte: doc.createdAt } });
  await audit(req, {
    action: "reserve", entity: "reservation", entityId: result.insertedId,
    summary: `${borrower.name} reserved "${book.title}" (position ${position} in the queue)`
  });
  return { _id: result.insertedId, ...doc, position, bookTitle: book.title, borrowerName: borrower.name };
}

// Ends an active reservation. A copy held for it moves to the next person waiting.
async function closeReservation(reservationId, { status, req }) {
  const outcome = await runTransaction(async (session, onRollback) => {
    const before = await reservations.findOneAndUpdate(
      { _id: reservationId, active: true, ...(status === "expired" && { status: "ready", holdUntil: { $lt: new Date() } }) },
      { $set: { status, active: false, closedAt: new Date() } },
      { session }
    );
    if (!before) {
      if (!(await reservations.countDocuments({ _id: reservationId }, { session }))) throw new HttpError(404, "Reservation not found.");
      throw new HttpError(409, "This reservation is no longer active.");
    }
    onRollback(() => reservations.updateOne({ _id: reservationId }, { $set: { status: before.status, active: true }, $unset: { closedAt: "" } }));

    const next = before.status === "ready" ? await releaseHeldCopy(before.bookId, session, onRollback) : null;
    const book = await books.findOne({ _id: before.bookId }, { session, projection: { title: 1 } });
    await audit(req, {
      action: status === "expired" ? "expire" : "cancel", entity: "reservation", entityId: reservationId,
      summary: `Reservation for "${book?.title}" ${status === "expired" ? "expired (not collected in time)" : "cancelled"}`
        + (before.status === "ready" ? (next ? "; held copy passed to the next person" : "; copy returned to the shelf") : "")
    }, session);
    return { next };
  });

  if (outcome.next) await notifyReservationReady(outcome.next).catch(err => console.error("Notify failed:", err.message));
  return outcome;
}

// Scheduled: reservations whose hold ran out without the book being collected
async function expireHolds() {
  const expired = await reservations.find({ status: "ready", holdUntil: { $lt: new Date() } }, { projection: { _id: 1 } }).toArray();
  for (const { _id } of expired) {
    await closeReservation(_id, { status: "expired", req: null }).catch(err => {
      if (!(err instanceof HttpError)) throw err;
    });
  }
  return expired.length;
}

// ---------------- FINE PAYMENTS ----------------

async function payFine({ loanId, method, req }) {
  return runTransaction(async (session, onRollback) => {
    const paidAt = new Date();
    const loan = await loans.findOneAndUpdate(
      { _id: loanId, returned: true, fine: { $gt: 0 }, finePaid: { $ne: true } },
      { $set: { finePaid: true, finePaidAt: paidAt } },
      { session, returnDocument: "after" }
    );
    if (!loan) {
      const existing = await loans.findOne({ _id: loanId }, { session });
      if (!existing) throw new HttpError(404, "Loan not found.");
      if (!existing.returned) throw new HttpError(409, "The book hasn't been returned yet. The fine is final only once it's back.");
      if (!(existing.fine > 0)) throw new HttpError(409, "This loan has no fine to pay.");
      throw new HttpError(409, "This fine has already been paid.");
    }
    onRollback(() => loans.updateOne({ _id: loanId }, { $unset: { finePaid: "", finePaidAt: "" } }));

    const payment = { loanId, borrowerId: loan.borrowerId, amount: loan.fine, method, paidAt, receivedBy: actorOf(req) };
    const result = await payments.insertOne(payment, { session });

    const [book, borrower] = await Promise.all([
      books.findOne({ _id: loan.bookId }, { session, projection: { title: 1 } }),
      borrowers.findOne({ _id: loan.borrowerId }, { session, projection: { name: 1 } })
    ]);
    await audit(req, {
      action: "pay", entity: "payment", entityId: result.insertedId,
      summary: `${borrower?.name ?? "A borrower"} paid ₹${loan.fine} (${method}) for "${book?.title}"`
    }, session);

    return { _id: result.insertedId, ...payment };
  });
}

module.exports = {
  DAY_MS, overdueDays, unpaidFines,
  issueLoan, returnLoan, createReservation, closeReservation, expireHolds, payFine
};
