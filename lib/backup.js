const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { BSON } = require("mongodb");
const { collections, runTransaction, DB_NAME } = require("../db");

const { EJSON } = BSON;
// Vercel's file system is read-only except the temporary folder
const DEFAULT_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "backups") : path.join(__dirname, "..", "backups");
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || DEFAULT_DIR);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 7;
const FILE_PATTERN = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/;
const NAMES = Object.keys(collections);

// Canonical Extended JSON keeps BSON types (ObjectId, Date, Int32, Double) exact,
// so a restore puts back documents identical to the originals.
async function createBackup() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const data = {};
  const counts = {};
  for (const name of NAMES) {
    data[name] = await collections[name].find({}).toArray();
    counts[name] = data[name].length;
  }
  const createdAt = new Date();
  const file = `backup-${createdAt.toISOString().slice(0, 19).replace(/:/g, "-")}Z.json`;
  const content = EJSON.stringify({ database: DB_NAME, createdAt, counts, collections: data }, { relaxed: false });
  await fs.writeFile(path.join(BACKUP_DIR, file), content);
  await pruneBackups();
  return { file, createdAt, counts, size: Buffer.byteLength(content) };
}

async function listBackups() {
  let names;
  try {
    names = await fs.readdir(BACKUP_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = await Promise.all(names.filter(n => FILE_PATTERN.test(n)).map(async file => {
    const stat = await fs.stat(path.join(BACKUP_DIR, file));
    return { file, size: stat.size, createdAt: stat.mtime };
  }));
  return files.sort((a, b) => b.file.localeCompare(a.file));
}

async function pruneBackups() {
  const files = await listBackups();
  for (const { file } of files.slice(BACKUP_KEEP)) await fs.unlink(path.join(BACKUP_DIR, file));
}

// Only plain backup file names are accepted, which also blocks "../" path tricks
function backupPath(file) {
  if (!FILE_PATTERN.test(file)) return null;
  return path.join(BACKUP_DIR, file);
}

// Replaces every collection with the backup's contents, in one transaction where supported
async function restoreBackup(filePath) {
  const backup = EJSON.parse(await fs.readFile(filePath, "utf8"), { relaxed: false });
  const counts = {};
  await runTransaction(async session => {
    for (const name of NAMES) {
      const docs = backup.collections?.[name] || [];
      await collections[name].deleteMany({}, { session });
      if (docs.length) await collections[name].insertMany(docs, { session, bypassDocumentValidation: true });
      counts[name] = docs.length;
    }
  });
  return { database: backup.database, createdAt: backup.createdAt, counts };
}

module.exports = { BACKUP_DIR, BACKUP_KEEP, createBackup, listBackups, backupPath, restoreBackup };
