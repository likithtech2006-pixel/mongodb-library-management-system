const QRCode = require("qrcode");
const { ObjectId } = require("mongodb");
const { collections, LOAN_DAYS } = require("../db");
const { HttpError, integer, idOf, normalizeIsbn, isIsbn, isEmail, formatDate } = require("../lib/validate");
const { issueLoan, returnLoan } = require("../lib/circulation");

const { books, borrowers, loans } = collections;

// Library cards carry "MEMBER:<borrower id>". Books are identified by ISBN, so
// both our QR labels and the EAN-13 barcode printed on real books work.
async function resolveCode(raw) {
  const code = String(raw ?? "").trim();
  if (!code) throw new HttpError(400, "Scan or type a code.");

  const card = /^MEMBER:([a-f\d]{24})$/i.exec(code);
  if (card) {
    const borrower = await borrowers.findOne({ _id: new ObjectId(card[1]) });
    if (!borrower) throw new HttpError(404, "No borrower matches this library card.");
    return { type: "borrower", item: borrower };
  }
  if (isEmail(code.toLowerCase())) {
    const borrower = await borrowers.findOne({ email: code.toLowerCase() });
    if (!borrower) throw new HttpError(404, "No borrower has this email.");
    return { type: "borrower", item: borrower };
  }
  const isbn = normalizeIsbn(code);
  if (isIsbn(isbn)) {
    const book = await books.findOne({ isbn });
    if (!book) throw new HttpError(404, `No book has ISBN ${isbn}.`);
    return { type: "book", item: book };
  }
  throw new HttpError(404, "This code doesn't match any book or library card.");
}

function describe({ type, item }) {
  return type === "book"
    ? { type, id: item._id, label: item.title, detail: `${item.author} · ${item.availableCopies} of ${item.totalCopies} on the shelf` }
    : { type, id: item._id, label: item.name, detail: `${item.email} · ${item.activeLoans} book(s) on loan` };
}

module.exports = function registerScanRoutes(app) {
  app.get("/api/scan/resolve", async (req, res) => {
    res.json(describe(await resolveCode(req.query.code)));
  });

  // Scan desk: one library card + one book. If the borrower has that book it
  // is returned, otherwise it is issued.
  app.post("/api/scan", async (req, res) => {
    const member = await resolveCode(req.body.memberCode);
    if (member.type !== "borrower") throw new HttpError(400, "Scan the library card first, then the book.");
    const target = await resolveCode(req.body.bookCode);
    if (target.type !== "book") throw new HttpError(400, "The second code must be a book (its ISBN barcode or QR label).");

    const borrower = member.item, book = target.item;
    const active = await loans.findOne({ bookId: book._id, borrowerId: borrower._id, returned: false });
    if (active) {
      const { loan } = await returnLoan(active._id, req);
      return res.json({
        action: "return",
        message: `"${book.title}" returned by ${borrower.name}.` + (loan.fine > 0 ? ` Fine: ₹${loan.fine}.` : " On time.")
      });
    }
    const loan = await issueLoan({
      bookId: book._id,
      borrowerId: borrower._id,
      days: integer(req.body.days, "Loan period", 1, 60, LOAN_DAYS),
      req
    });
    res.status(201).json({ action: "issue", message: `"${book.title}" issued to ${borrower.name}, due ${formatDate(loan.dueDate)}.` });
  });

  // Printable QR codes: a book label (ISBN) or a borrower's library card
  app.get("/api/qr/:kind/:id", async (req, res) => {
    const id = idOf(req.params.id, req.params.kind);
    let payload;
    if (req.params.kind === "book") {
      const book = await books.findOne({ _id: id }, { projection: { isbn: 1 } });
      if (!book) throw new HttpError(404, "Book not found.");
      payload = book.isbn;
    } else if (req.params.kind === "borrower") {
      if (!(await borrowers.countDocuments({ _id: id }))) throw new HttpError(404, "Borrower not found.");
      payload = `MEMBER:${id}`;
    } else {
      throw new HttpError(404, "Unknown QR type.");
    }
    const svg = await QRCode.toString(payload, { type: "svg", margin: 1, width: 240, errorCorrectionLevel: "M" });
    res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
  });
};
