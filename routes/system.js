const { collections } = require("../db");
const { HttpError, integer, oneOf } = require("../lib/validate");
const { audit } = require("../lib/audit");
const { channels } = require("../lib/notify");
const { createBackup, listBackups, backupPath, BACKUP_KEEP } = require("../lib/backup");
const { runCirculationJobs, schedule } = require("../lib/scheduler");

const { notifications, auditLogs } = collections;
const ENTITIES = ["book", "author", "borrower", "loan", "reservation", "payment", "backup", "system"];

module.exports = function registerSystemRoutes(app) {
  // ---------- Backups ----------
  app.get("/api/backups", async (req, res) => {
    res.json({ keep: BACKUP_KEEP, intervalHours: schedule.backupIntervalHours, scheduled: schedule.enabled, files: await listBackups() });
  });

  app.post("/api/backups", async (req, res) => {
    const backup = await createBackup();
    const total = Object.values(backup.counts).reduce((a, b) => a + b, 0);
    await audit(req, { action: "backup", entity: "backup", summary: `Manual backup ${backup.file} (${total} documents)` });
    res.status(201).json({ message: `Backup saved: ${total} documents in ${backup.file}.`, backup });
  });

  app.get("/api/backups/:file", async (req, res) => {
    const file = backupPath(req.params.file);
    if (!file) throw new HttpError(400, "Invalid backup file name.");
    res.download(file, req.params.file, err => {
      if (err && !res.headersSent) res.status(404).json({ error: "Backup not found." });
    });
  });

  // ---------- Reminders (email / SMS outbox) ----------
  app.get("/api/notifications", async (req, res) => {
    const limit = integer(req.query.limit, "Limit", 1, 200, 50);
    res.json({
      channels,
      items: await notifications.aggregate([
        { $sort: { createdAt: -1 } },
        { $limit: limit },
        { $lookup: { from: "borrowers", localField: "borrowerId", foreignField: "_id", as: "borrower" } },
        { $set: { borrowerName: { $first: "$borrower.name" } } },
        { $unset: "borrower" }
      ]).toArray()
    });
  });

  app.post("/api/notifications/run", async (req, res) => {
    const result = await runCirculationJobs();
    await audit(req, {
      action: "remind", entity: "system",
      summary: `Reminder run: ${result.dueSoon} due-soon, ${result.overdue} overdue, ${result.expiredHolds} expired hold(s)`
    });
    res.json({
      message: `Sent ${result.dueSoon} due-soon and ${result.overdue} overdue reminder(s); ${result.expiredHolds} expired hold(s).`,
      ...result
    });
  });

  // Vercel Cron calls this once a day (see vercel.json). Vercel sends CRON_SECRET as a bearer token when it is set.
  app.get("/api/cron", async (req, res) => {
    if (process.env.CRON_SECRET && req.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
      throw new HttpError(401, "Unauthorized.");
    }
    const result = await runCirculationJobs();
    await audit(null, {
      action: "remind", entity: "system",
      summary: `Daily cron: ${result.dueSoon} due-soon, ${result.overdue} overdue, ${result.expiredHolds} expired hold(s)`
    });
    res.json(result);
  });

  // ---------- Audit log ----------
  app.get("/api/audit", async (req, res) => {
    const limit = integer(req.query.limit, "Limit", 1, 500, 100);
    const filter = req.query.entity ? { entity: oneOf(req.query.entity, "Entity", ENTITIES) } : {};
    res.json(await auditLogs.find(filter).sort({ at: -1 }).limit(limit).toArray());
  });
};
