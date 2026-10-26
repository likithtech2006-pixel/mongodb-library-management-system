const { ObjectId } = require("mongodb");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function text(value, field, { required = false, max = 200 } = {}) {
  if (isBlank(value)) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return undefined;
  }
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

function integer(value, field, min, max, fallback) {
  if (isBlank(value)) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function normalizeIsbn(value) {
  return String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
}

const isIsbn = s => /^(\d{9}[\dX]|\d{13})$/.test(s);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function isbnOf(value, required = false) {
  const raw = text(value, "ISBN", { required, max: 20 });
  if (raw === undefined) return undefined;
  const isbn = normalizeIsbn(raw);
  if (!isIsbn(isbn)) throw new HttpError(400, "ISBN must have 10 or 13 digits (hyphens are allowed).");
  return isbn;
}

function emailOf(value, required = false) {
  const raw = text(value, "Email", { required, max: 254 });
  if (raw === undefined) return undefined;
  const email = raw.toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Email address is not valid.");
  return email;
}

// Phone numbers are stored as digits with an optional leading +, e.g. +919876543210
function phoneOf(value) {
  const raw = text(value, "Phone", { max: 20 });
  if (raw === undefined) return undefined;
  const phone = raw.replace(/[\s()-]/g, "");
  if (!/^\+?[0-9]{10,15}$/.test(phone)) throw new HttpError(400, "Phone must have 10 to 15 digits, optionally starting with +.");
  return phone;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}.`);
  return value;
}

function idOf(value, what) {
  if (!/^[a-f\d]{24}$/i.test(String(value ?? ""))) throw new HttpError(400, `Invalid ${what} ID.`);
  return new ObjectId(String(value));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const formatDate = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

module.exports = {
  HttpError, isBlank, text, integer, normalizeIsbn, isIsbn, isEmail,
  isbnOf, emailOf, phoneOf, oneOf, idOf, escapeRegex, formatDate
};
