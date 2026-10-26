# MongoDB Library Management System

A library management web app built with **MongoDB**, **Node.js/Express** and a plain HTML/CSS/JavaScript frontend. It has a dashboard, dark/light themes, and an "Index lab" that shows MongoDB's query plans live.

## Requirements covered

### 5 user-defined functionalities
1. **Add Book**: the author is found or created in the same transaction; supports multiple copies
2. **Register Borrower**: email is validated, lower-cased and unique
3. **Issue Book**: atomic copy reservation, 3-book borrowing limit, custom loan period
4. **Return Book**: the overdue fine is calculated by MongoDB itself (`$$NOW` in a pipeline update)
5. **View/Search Books**: filter, sort and paginate, plus weighted full-text search

### 5 NoSQL/MongoDB functionalities
| Feature | Where to see it |
|---|---|
| **CRUD** | Books, borrowers and authors can all be created, read, updated and deleted |
| **Indexing** | Unique, compound, case-insensitive (collation), weighted text and **partial unique** indexes; the Books page shows `explain()` output comparing the text index with a full collection scan |
| **Aggregation** | Dashboard: `$facet`, `$group`, `$bucket`, `$dateToString`, `$lookup`, `$sort`/`$limit`; pagination uses `$facet` |
| **Text Search** | `$text` over title (weight 10), author (5) and description (1), ranked by `textScore` |
| **Data Validation** | `$jsonSchema` with types, ranges, `pattern` for ISBN/email, plus `$expr` rules (`availableCopies ≤ totalCopies`, `dueDate > issuedAt`) |

### Extra database features
- **Multi-document ACID transactions** for issue, return and add-book (falls back to manual rollback on a standalone server)
- **Atomic conditional updates** (`findOneAndUpdate` with a filter): two people can't grab the last copy at the same time
- **Optimistic locking** when editing a book's copy count
- **Referencing + denormalisation**: books store `authorId` (joined with `$lookup`) and a copy of the author's name (for text search)
- **Schema migration** on startup for data created by older versions of the app
- **Window functions**: reservation queue positions with `$setWindowFields` + `$documentNumber`

### Library features
| Feature | How it works |
|---|---|
| **Reservations** | When every copy is out, borrowers join a queue. A returned copy is **held** for the first person (`heldCopies`) for 3 days and they're notified; uncollected holds pass to the next person automatically |
| **Fine payment tracking** | Fines are fixed on return; paying records a `payments` document and marks the loan paid in one transaction. Borrowers owing more than ₹100 can't borrow |
| **Email / SMS reminders** | A reminder 2 days before the due date, an overdue notice, and "your reservation is ready". Sent by SMTP / Twilio when configured; always recorded in the `notifications` outbox |
| **Barcode / QR scanning** | Scan desk on Circulation: scan a library card, then a book's ISBN barcode or QR label. It issues or returns automatically. Works with USB scanners, the camera (Chrome/Edge) or typing |
| **Backups** | Automatic backup every 24 h (newest 7 kept), "Back up now" and download on the System page, `npm run backup` / `npm run restore` |
| **Audit log** | Every change is logged with who did it, in the same transaction as the change (Activity page) |
| **Automated tests** | `npm test`: 15 end-to-end tests against a throwaway database, including a 6-way race for the last copy |

## Collections

| Collection | Purpose |
|---|---|
| `books` | title, author, authorId, isbn, description, totalCopies, availableCopies, heldCopies, borrowCount |
| `authors` | name (unique, case-insensitive) |
| `borrowers` | name, email (unique), phone, activeLoans |
| `loans` | bookId, borrowerId, issuedAt, dueDate, returned, returnedAt, fine, finePaid, reminder timestamps |
| `reservations` | bookId, borrowerId, status (waiting / ready / fulfilled / cancelled / expired), holdUntil |
| `payments` | loanId (unique), borrowerId, amount, method, paidAt, receivedBy |
| `notifications` | type, channel (email / sms), to, subject, body, status (sent / logged / failed) |
| `auditLogs` | at, action, entity, entityId, summary, actor |

Database name: `library_management`

## Run

Requires **Node.js 20.12+** and **MongoDB 6+**.

```bash
npm install
npm run seed      # optional sample data (refuses to wipe existing data without --force)
npm start
```

Open http://localhost:3000

`npm run dev` restarts the server automatically when you edit a file.

| Command | What it does |
|---|---|
| `npm test` | Runs the automated tests (needs a local MongoDB; uses its own temporary database) |
| `npm run backup` | Saves every collection to `backups/backup-<time>.json` |
| `npm run restore -- backups/<file> --force` | Replaces all data with a backup |

### Configuration
Copy `.env.example` to `.env` to change the MongoDB URL, database name, port and library rules. It also explains how to turn on real email (any SMTP server, e.g. Gmail with an app password) and SMS (Twilio). Without them, reminders are still recorded in the outbox on the System page.

### Enabling transactions
Transactions need MongoDB to run as a replica set. A single-node replica set is enough:

1. Add this to your `mongod.conf` (macOS Homebrew: `/opt/homebrew/etc/mongod.conf`, Windows: `C:\Program Files\MongoDB\Server\<version>\bin\mongod.cfg`):
   ```yaml
   replication:
     replSetName: rs0
   ```
2. Restart MongoDB, then run once in `mongosh`:
   ```js
   rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })
   ```

The sidebar shows "transactions on" when it works. Without a replica set the app still runs and undoes completed steps by hand if a later one fails.

### Reloading sample data
```bash
npm run seed -- --force
```
This **deletes** all library data first.

## Demo flow

1. **Dashboard**: aggregation results (loans per month, popularity buckets, top books and authors, overdue loans)
2. **Books → Add book**: try a duplicate ISBN or an invalid one to show validation
3. **Borrowers → Register**: try a duplicate email
4. **Circulation → Issue**: issue a book; try issuing to a borrower who already has 3 books
5. **Circulation → Return**: return an overdue book and see the fine
6. **Books → search** "database": the Index lab shows `IXSCAN` on the text index vs `COLLSCAN` for a regex
7. **Borrowers → history icon**: loan history joined with `$lookup`
8. **Reservations**: reserve "Designing Data-Intensive Applications"; return Priya's copy and watch it become "ready" for the first person
9. **Circulation → Scan desk**: scan a library card (Borrowers → card icon) and a book's QR label (Books → QR icon)
10. **Fines**: record a payment; try issuing to someone over the unpaid-fine limit
11. **System**: back up now, send reminders, check the outbox; **Activity** shows who did each step
12. `npm test` in a terminal: all 15 tests pass
13. In MongoDB Compass: show the indexes and the validation rules on each collection
14. Toggle dark/light mode (bottom of the sidebar)
