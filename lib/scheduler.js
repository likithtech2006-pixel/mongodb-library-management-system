const { sendDueReminders } = require("./reminders");
const { expireHolds } = require("./circulation");
const { createBackup, listBackups } = require("./backup");
const { audit } = require("./audit");

const REMINDER_CHECK_MINUTES = Number(process.env.REMINDER_CHECK_MINUTES) || 60;
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS) || 24;
// Serverless functions don't stay running, so on Vercel the daily cron in vercel.json calls /api/cron instead
const runtime = process.env.VERCEL ? "vercel" : "server";
const enabled = process.env.SCHEDULER !== "off" && runtime === "server";

async function runCirculationJobs() {
  const reminders = await sendDueReminders();
  const expiredHolds = await expireHolds();
  return { ...reminders, expiredHolds };
}

async function runBackupJob() {
  const backup = await createBackup();
  await audit(null, { action: "backup", entity: "backup", summary: `Automatic backup ${backup.file}` });
  return backup;
}

// Takes a backup at start-up when the newest one is older than the interval,
// so a server that restarts often still gets its daily backup.
async function backupIfDue() {
  const [latest] = await listBackups();
  if (!latest || Date.now() - latest.createdAt.getTime() > BACKUP_INTERVAL_HOURS * 3600_000) await runBackupJob();
}

function startScheduler() {
  if (!enabled) return () => {};
  const safely = (name, job) => () => job().catch(err => console.error(`Scheduled ${name} failed:`, err.message));

  const first = setTimeout(() => {
    safely("reminders", runCirculationJobs)();
    safely("backup", backupIfDue)();
  }, 5000);
  const reminders = setInterval(safely("reminders", runCirculationJobs), REMINDER_CHECK_MINUTES * 60_000);
  const backups = setInterval(safely("backup", runBackupJob), BACKUP_INTERVAL_HOURS * 3600_000);
  [first, reminders, backups].forEach(t => t.unref());

  return () => [first, reminders, backups].forEach(clearInterval);
}

module.exports = {
  startScheduler, runCirculationJobs, runBackupJob,
  schedule: { enabled, runtime, reminderCheckMinutes: REMINDER_CHECK_MINUTES, backupIntervalHours: BACKUP_INTERVAL_HOURS }
};
