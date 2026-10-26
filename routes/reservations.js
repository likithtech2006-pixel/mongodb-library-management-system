const { collections } = require("../db");
const { idOf } = require("../lib/validate");
const { createReservation, closeReservation } = require("../lib/circulation");

const { reservations } = collections;
const STATUS_ORDER = ["ready", "waiting", "fulfilled", "expired", "cancelled"];

module.exports = function registerReservationRoutes(app) {
  // Active queue (or full history with ?scope=all), each waiting reservation
  // numbered by its place in the queue for that book
  app.get("/api/reservations", async (req, res) => {
    const all = req.query.scope === "all";
    res.json(await reservations.aggregate([
      { $match: all ? {} : { active: true } },
      { $setWindowFields: {
          partitionBy: { bookId: "$bookId", waiting: { $eq: ["$status", "waiting"] } },
          sortBy: { createdAt: 1 },
          output: { position: { $documentNumber: {} } }
      }},
      { $lookup: { from: "books", localField: "bookId", foreignField: "_id", as: "book" } },
      { $lookup: { from: "borrowers", localField: "borrowerId", foreignField: "_id", as: "borrower" } },
      { $project: {
          bookId: 1, borrowerId: 1, status: 1, createdAt: 1, readyAt: 1, holdUntil: 1, closedAt: 1,
          position: { $cond: [{ $eq: ["$status", "waiting"] }, "$position", null] },
          bookTitle: { $ifNull: [{ $first: "$book.title" }, "(deleted book)"] },
          borrowerName: { $ifNull: [{ $first: "$borrower.name" }, "(deleted borrower)"] },
          borrowerEmail: { $first: "$borrower.email" },
          order: { $indexOfArray: [STATUS_ORDER, "$status"] }
      }},
      { $sort: { order: 1, bookTitle: 1, position: 1, closedAt: -1 } },
      { $limit: all ? 200 : 500 },
      { $unset: "order" }
    ]).toArray());
  });

  app.post("/api/reservations", async (req, res) => {
    const reservation = await createReservation({
      bookId: idOf(req.body.bookId, "book"),
      borrowerId: idOf(req.body.borrowerId, "borrower"),
      req
    });
    res.status(201).json({
      message: `${reservation.borrowerName} is number ${reservation.position} in the queue for "${reservation.bookTitle}".`,
      reservation
    });
  });

  app.delete("/api/reservations/:id", async (req, res) => {
    const { next } = await closeReservation(idOf(req.params.id, "reservation"), { status: "cancelled", req });
    res.json({ message: next ? "Reservation cancelled. The held copy went to the next person in the queue." : "Reservation cancelled." });
  });
};
