// npm run backup: saves every collection to backups/backup-<time>.json
const { connect, close } = require("../db");
const { createBackup, BACKUP_DIR, BACKUP_KEEP } = require("../lib/backup");
const { audit } = require("../lib/audit");

(async () => {
  await connect();
  const backup = await createBackup();
  await audit(null, { action: "backup", entity: "backup", summary: `Command-line backup ${backup.file}` });
  console.log(`Saved ${backup.file} in ${BACKUP_DIR} (${(backup.size / 1024).toFixed(1)} KB)`);
  console.log(Object.entries(backup.counts).map(([name, n]) => `  ${name}: ${n}`).join("\n"));
  console.log(`Keeping the newest ${BACKUP_KEEP} backups.`);
})()
  .catch(err => {
    console.error("Backup failed:", err.message);
    process.exitCode = 1;
  })
  .finally(close);
