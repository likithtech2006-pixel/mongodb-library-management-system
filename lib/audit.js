const { collections } = require("../db");

// No login yet, so the "who" is the staff name the browser sends with each
// request (set on the System page). Scheduled jobs pass no request: "System".
function actorOf(req) {
  if (!req) return "System";
  let name = String(req.get("X-Staff-Name") || "");
  try { name = decodeURIComponent(name); } catch {}
  name = name.trim().slice(0, 100);
  return name || "Librarian";
}

// Writes one audit log entry. Pass the transaction's session so the log
// entry is committed (or rolled back) together with the change it describes.
async function audit(req, { action, entity, entityId, summary }, session) {
  await collections.auditLogs.insertOne({
    at: new Date(),
    action,
    entity,
    ...(entityId && { entityId }),
    summary: summary.slice(0, 500),
    actor: actorOf(req),
    ...(req?.ip && { ip: req.ip })
  }, { session });
}

module.exports = { audit, actorOf };
