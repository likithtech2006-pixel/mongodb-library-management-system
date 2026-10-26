// npm run restore -- backups/backup-<time>.json --force
// Replaces ALL library data with the backup's contents.
const path = require("path");
const { connect, close, DB_NAME } = require("../db");
const { restoreBackup, listBackups, BACKUP_DIR } = require("../lib/backup");
const { audit } = require("../lib/audit");

(async () => {
  const file = process.argv.slice(2).find(a => !a.startsWith("--"));
  if (!file) {
    const files = await listBackups();
    console.log("Usage: npm run restore -- <backup file> --force\n");
    console.log(files.length ? `Backups in ${BACKUP_DIR}:\n${files.map(f => `  ${f.file}`).join("\n")}` : `No backups in ${BACKUP_DIR} yet. Run npm run backup.`);
    process.exitCode = 1;
    return;
  }
  if (!process.argv.includes("--force")) {
    console.log(`This replaces everything in "${DB_NAME}" with ${path.basename(file)}.`);
    console.log("Run it again with --force to continue.");
    process.exitCode = 1;
    return;
  }

  await connect();
  const result = await restoreBackup(path.resolve(file));
  await audit(null, { action: "restore", entity: "backup", summary: `Restored ${path.basename(file)}` });
  console.log(`Restored ${path.basename(file)} (taken ${new Date(result.createdAt).toLocaleString()} from "${result.database}") into "${DB_NAME}":`);
  console.log(Object.entries(result.counts).map(([name, n]) => `  ${name}: ${n}`).join("\n"));
})()
  .catch(err => {
    console.error("Restore failed:", err.message);
    process.exitCode = 1;
  })
  .finally(close);
