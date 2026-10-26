const nodemailer = require("nodemailer");
const { collections } = require("../db");

// Email goes out through any SMTP server (e.g. Gmail with an app password) and
// SMS through Twilio. Without credentials the message is still written to the
// notifications collection with status "logged", so the outbox always shows
// what would have been sent.
const channels = {
  email: Boolean(process.env.SMTP_HOST),
  sms: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)
};

let transporter;
function mailer() {
  const port = Number(process.env.SMTP_PORT) || 587;
  transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}

async function sendSms(to, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: to, Body: message.slice(0, 1500) })
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function deliver(channel, to, subject, body) {
  if (!channels[channel]) return { status: "logged" };
  if (channel === "email") {
    await mailer().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text: body });
  } else {
    await sendSms(to, `${subject}: ${body}`);
  }
  return { status: "sent" };
}

// Sends one message to a borrower by email, and by SMS too when they have a phone number
async function notifyBorrower(borrower, { type, subject, body, loanId, reservationId }) {
  const targets = [["email", borrower.email]];
  if (borrower.phone) targets.push(["sms", borrower.phone]);

  const records = [];
  for (const [channel, to] of targets) {
    let outcome;
    try {
      outcome = await deliver(channel, to, subject, body);
    } catch (err) {
      outcome = { status: "failed", error: String(err.message).slice(0, 300) };
    }
    const doc = {
      type, channel, to, subject, body, ...outcome,
      borrowerId: borrower._id,
      ...(loanId && { loanId }),
      ...(reservationId && { reservationId }),
      createdAt: new Date()
    };
    await collections.notifications.insertOne(doc);
    records.push(doc);
  }
  return records;
}

module.exports = { notifyBorrower, channels };
