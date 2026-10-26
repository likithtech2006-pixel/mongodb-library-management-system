const { collections, FINE_PER_DAY, REMINDER_DAYS_BEFORE } = require("../db");
const { formatDate } = require("./validate");
const { notifyBorrower } = require("./notify");
const { DAY_MS } = require("./circulation");

const { books, borrowers, loans } = collections;

async function notifyAboutLoan(loan, type) {
  const [book, borrower] = await Promise.all([
    books.findOne({ _id: loan.bookId }, { projection: { title: 1 } }),
    borrowers.findOne({ _id: loan.borrowerId })
  ]);
  if (!book || !borrower) return [];

  const title = `"${book.title}"`;
  const message = type === "due_soon"
    ? { subject: `Reminder: ${title} is due ${formatDate(loan.dueDate)}`,
        body: `Hi ${borrower.name}, ${title} is due back on ${formatDate(loan.dueDate)}. Late returns are fined ₹${FINE_PER_DAY} per day.` }
    : { subject: `Overdue: ${title}`,
        body: `Hi ${borrower.name}, ${title} was due on ${formatDate(loan.dueDate)}. A fine of ₹${FINE_PER_DAY} per day is building up until it is returned.` };

  return notifyBorrower(borrower, { type, loanId: loan._id, ...message });
}

// Each loan is "claimed" with findOneAndUpdate before its message is sent, so a
// reminder is never sent twice, even if two servers run this job at once.
async function claimAndNotify(filter, stampField, type) {
  let count = 0;
  for (;;) {
    const loan = await loans.findOneAndUpdate(
      { ...filter, [stampField]: { $exists: false } },
      { $set: { [stampField]: new Date() } },
      { sort: { dueDate: 1 }, returnDocument: "after" }
    );
    if (!loan) return count;
    await notifyAboutLoan(loan, type);
    count++;
  }
}

async function sendDueReminders() {
  const now = new Date();
  const soon = new Date(now.getTime() + REMINDER_DAYS_BEFORE * DAY_MS);
  const dueSoon = await claimAndNotify({ returned: false, dueDate: { $gte: now, $lte: soon } }, "reminderSentAt", "due_soon");
  const overdue = await claimAndNotify({ returned: false, dueDate: { $lt: now } }, "overdueNoticeAt", "overdue");
  return { dueSoon, overdue };
}

module.exports = { sendDueReminders };
