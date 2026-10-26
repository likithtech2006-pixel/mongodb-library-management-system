const { collections, FINE_PER_DAY, MAX_UNPAID_FINE } = require("../db");
const { idOf, oneOf } = require("../lib/validate");
const { payFine, overdueDays } = require("../lib/circulation");

const { loans, payments } = collections;
const METHODS = ["cash", "upi", "card"];

module.exports = function registerFineRoutes(app) {
  app.get("/api/fines", async (req, res) => {
    const [outstanding, recent, [paid], [running]] = await Promise.all([
      loans.aggregate([
        { $match: { returned: true, fine: { $gt: 0 }, finePaid: { $ne: true } } },
        { $sort: { returnedAt: -1 } },
        { $lookup: { from: "books", localField: "bookId", foreignField: "_id", as: "book" } },
        { $lookup: { from: "borrowers", localField: "borrowerId", foreignField: "_id", as: "borrower" } },
        { $project: {
            fine: 1, dueDate: 1, returnedAt: 1, borrowerId: 1,
            bookTitle: { $ifNull: [{ $first: "$book.title" }, "(deleted book)"] },
            borrowerName: { $ifNull: [{ $first: "$borrower.name" }, "(deleted borrower)"] },
            borrowerEmail: { $first: "$borrower.email" }
        }}
      ]).toArray(),
      payments.aggregate([
        { $sort: { paidAt: -1 } },
        { $limit: 20 },
        { $lookup: { from: "borrowers", localField: "borrowerId", foreignField: "_id", as: "borrower" } },
        { $lookup: { from: "loans", localField: "loanId", foreignField: "_id", as: "loan" } },
        { $lookup: { from: "books", localField: "loan.bookId", foreignField: "_id", as: "book" } },
        { $project: {
            amount: 1, method: 1, paidAt: 1, receivedBy: 1,
            borrowerName: { $ifNull: [{ $first: "$borrower.name" }, "(deleted borrower)"] },
            bookTitle: { $ifNull: [{ $first: "$book.title" }, "(deleted book)"] }
        }}
      ]).toArray(),
      payments.aggregate([{ $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]).toArray(),
      // Fines still growing on books that are overdue right now (not payable until returned)
      loans.aggregate([
        { $match: { returned: false, dueDate: { $lt: new Date() } } },
        { $group: { _id: null, total: { $sum: { $multiply: [overdueDays("$$NOW"), FINE_PER_DAY] } } } }
      ]).toArray()
    ]);

    res.json({
      outstanding,
      totalOutstanding: outstanding.reduce((sum, f) => sum + f.fine, 0),
      collected: paid?.total || 0,
      paymentCount: paid?.count || 0,
      runningOnOverdue: running?.total || 0,
      maxUnpaid: MAX_UNPAID_FINE,
      payments: recent
    });
  });

  app.post("/api/loans/:id/pay", async (req, res) => {
    const payment = await payFine({
      loanId: idOf(req.params.id, "loan"),
      method: oneOf(String(req.body.method || "cash"), "Payment method", METHODS),
      req
    });
    res.status(201).json({ message: `Payment of ₹${payment.amount} recorded (${payment.method}).`, payment });
  });
};
