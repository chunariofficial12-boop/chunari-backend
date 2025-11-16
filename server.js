// server.js - Razorpay + Invoice PDF + GitHub commit + SMTP email (non-blocking email)
require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");

const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

// GitHub uploader module (utils/githubUploader.js)
const { uploadFileToGitHub } = require("./utils/githubUploader");

// ---------- Helpers ----------
const TMP_DIR = "/tmp/invoices";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const moneyFromPaise = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;

function safeEnv(name, fallback = undefined) {
  const v = process.env[name];
  return typeof v === "string" && v.length ? v : fallback;
}

// Create invoice PDF on disk and return file path
function makeInvoicePDFFile({ orderId, paymentId, amountPaise, customer = {}, cart = [] }) {
  return new Promise((resolve, reject) => {
    const safeId = String(orderId || Date.now()).replace(/[^a-zA-Z0-9-_]/g, "_");
    const fileName = `invoice-order_${safeId}.pdf`;
    const filePath = path.join(TMP_DIR, fileName);
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const storeName = safeEnv("STORE_NAME", "Your Store");
    const storeEmail = safeEnv("STORE_EMAIL", "");
    const storePhone = safeEnv("STORE_PHONE", "");
    const storeAddress = safeEnv("STORE_ADDRESS", "");

    // Header (left)
    doc
      .fontSize(20)
      .text(storeName, { align: "left" })
      .moveDown(0.2)
      .fontSize(10)
      .text(storeAddress)
      .text(`Phone: ${storePhone}`)
      .text(`Email: ${storeEmail}`)
      .moveDown();

    // Right side: INVOICE + date (IST), Order ID, Payment ID
    doc
      .fontSize(16)
      .text("INVOICE", { align: "right" })
      .fontSize(10)
      .text(
        `Date: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
        { align: "right" }
      )
      .text(`Order ID: ${orderId}`, { align: "right" })
      .text(`Payment ID: ${paymentId || "-"}`, { align: "right" })
      .moveDown();

    // Bill to
    doc
      .fontSize(12)
      .text("Bill To", { underline: true })
      .fontSize(10)
      .text(customer.name || "")
      .text(customer.address1 || "")
      .text(customer.address2 || "")
      .text([customer.city, customer.state, customer.pincode].filter(Boolean).join(", "))
      .text(`Phone: ${customer.phone || ""}`)
      .text(`Email: ${customer.email || ""}`)
      .moveDown();

    // Items table header
    doc.fontSize(11).text("Items:", { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    const colX = [40, 300, 380];
    doc.text("Item", colX[0], doc.y);
    doc.text("Qty x Price", colX[1], doc.y);
    doc.text("Amount", colX[2], doc.y);
    doc.moveDown(0.2);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();

    let subtotal = 0;
    (cart || []).forEach((it) => {
      const qty = Number(it.qty || 1);
      const price = Number(it.price || 0);
      const amount = qty * price;
      subtotal += amount;

      doc.moveDown(0.3);
      doc.text(it.name || "", colX[0], doc.y);
      doc.text(`${qty} x ₹${price.toFixed(2)}`, colX[1], doc.y);
      doc.text(`₹${amount.toFixed(2)}`, colX[2], doc.y);
    });

    // If cart empty, show total from amountPaise
    if (!(cart && cart.length)) {
      const totalRs = typeof amountPaise === "number" ? amountPaise / 100 : 0;
      subtotal = totalRs;
    }

    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();
    doc.moveDown(0.5);
    doc.text(`Subtotal: ₹${subtotal.toFixed(2)}`, { align: "right" });
    doc.text(`Tax (GST not registered): ₹0.00`, { align: "right" });
    if (typeof amountPaise === "number") {
      doc.text(`Total Paid: ${moneyFromPaise(amountPaise)}`, { align: "right" });
    }

    doc.moveDown(1);
    doc.fontSize(9).text("Note: GST not registered. This is a computer-generated invoice.");

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", (err) => reject(err));
  });
}

// Setup nodemailer transporter (from env). Supports Gmail app-passwords.
function makeTransporter() {
  const host = safeEnv("SMTP_HOST");
  const port = Number(safeEnv("SMTP_PORT", 587));
  const user = safeEnv("SMTP_USER");
  const pass = safeEnv("SMTP_PASS");

  if (!host || !user || !pass) {
    return null;
  }

  // For Gmail with app password use: host=smtp.gmail.com, port=587, secure=false and auth user=email / pass=app-password
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for 587
    auth: { user, pass },
    // Useful timeouts and TLS relax for some hosts (only if needed)
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    tls: {
      // allow self-signed certs if your SMTP provider requires it; set to false for Gmail/standard providers
      rejectUnauthorized: safeEnv("SMTP_REJECT_UNAUTHORIZED", "true") === "true",
    },
  });
}

// ---------- App ----------
const app = express();
app.use(cors());

// Important: route-specific raw body parser for webhook must be registered
app.use("/razorpay-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const razorpay = new Razorpay({
  key_id: safeEnv("RAZORPAY_KEY_ID"),
  key_secret: safeEnv("RAZORPAY_KEY_SECRET"),
});

// Create order (amount in paise)
app.post("/create-order", async (req, res) => {
  try {
    const amount = Number(req.body.amount); // paise
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Amount (paise) is required and must be > 0" });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
      payment_capture: 1,
    });

    res.json(order);
  } catch (error) {
    console.error("create-order error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// Verify payment, generate invoice, commit to GitHub, and email customer
app.post("/verify", async (req, res) => {
  let pdfPath = null;
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amountPaise, customer, cart } =
      req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    // HMAC verification
    const expected = crypto
      .createHmac("sha256", safeEnv("RAZORPAY_KEY_SECRET") || "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Invalid signature" });
    }

    console.log("✅ Payment verified:", razorpay_order_id);

    // Generate PDF invoice
    pdfPath = await makeInvoicePDFFile({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise: typeof amountPaise === "number" ? amountPaise : undefined,
      customer: customer || {},
      cart: Array.isArray(cart) ? cart : [],
    });

    // Upload file to GitHub (best-effort)
    let githubResult = null;
    try {
      const owner = safeEnv("GITHUB_OWNER");
      const repo = safeEnv("GITHUB_REPO");
      const branch = safeEnv("GITHUB_BRANCH", "main");
      const repoPath = `invoices/${path.basename(pdfPath)}`;

      if (!owner || !repo) {
        console.warn("GITHUB_OWNER or GITHUB_REPO not set - skipping GitHub upload.");
      } else if (!safeEnv("GITHUB_TOKEN")) {
        console.warn("GITHUB_TOKEN is missing - skipping GitHub upload.");
      } else {
        githubResult = await uploadFileToGitHub({
          owner,
          repo,
          branch,
          path: repoPath,
          localFilePath: pdfPath,
          token: safeEnv("GITHUB_TOKEN"),
          commitMessage: `Add invoice for ${razorpay_order_id}`,
        });
        console.log("GitHub upload OK.");
      }
    } catch (ghErr) {
      console.error("GitHub upload error (non-fatal):", ghErr);
    }

    // Prepare email (send in background - non-blocking)
    try {
      const transporter = makeTransporter();
      const toEmail = customer && customer.email ? customer.email : null;
      if (!transporter) {
        console.warn("SMTP not configured - skipping email.");
      } else if (!toEmail) {
        console.warn("Customer email missing - skipping email.");
      } else {
        const from = safeEnv("FROM_EMAIL") || safeEnv("SMTP_USER");
        const subject = safeEnv("INVOICE_EMAIL_SUBJECT") || `Your CHUNARI Invoice - ${razorpay_order_id}`;
        const textBody = `Hello ${customer && customer.name ? customer.name : ""},\n\nThank you for your order. Please find attached your invoice (Order: ${razorpay_order_id}).\n\nRegards,\n${safeEnv(
          "STORE_NAME",
          "CHUNARI"
        )}`;

        // send in background - do NOT await here
        transporter
          .sendMail({
            from,
            to: toEmail,
            bcc: safeEnv("BCC_EMAIL") || undefined,
            subject,
            text: textBody,
            attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
          })
          .then((info) => {
            console.log("Email sent (background):", info && (info.messageId || info.response));
          })
          .catch((err) => {
            console.warn("Email error (background, non-fatal):", err && (err.message || err));
          });
      }
    } catch (mailErr) {
      console.error("Email setup error (non-fatal):", mailErr);
    }

    // Try immediate cleanup (if delete fails, ignore)
    try {
      if (pdfPath) await fsPromises.unlink(pdfPath);
    } catch (e) {
      // ignore
    }

    // Return success to caller (do NOT wait for email)
    return res.json({
      ok: true,
      order: razorpay_order_id,
      payment: razorpay_payment_id,
      github: githubResult ? { commitSha: githubResult.commit && githubResult.commit.sha } : null,
      emailQueued: true,
    });
  } catch (err) {
    console.error("verify error:", err);
    try {
      if (pdfPath) await fsPromises.unlink(pdfPath);
    } catch (e) {}
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Razorpay webhook endpoint
// Razorpay POSTS raw JSON and sets header X-Razorpay-Signature
app.post("/razorpay-webhook", (req, res) => {
  try {
    const rawBody = req.body; // raw Buffer (because route uses express.raw)
    const bodyStr = rawBody && rawBody.toString ? rawBody.toString("utf8") : "";

    const webhookSecret = safeEnv("RAZORPAY_WEBHOOK_SECRET");
    const signature = (req.headers["x-razorpay-signature"] || "").toString();

    if (webhookSecret) {
      const expected = crypto.createHmac("sha256", webhookSecret).update(bodyStr).digest("hex");
      if (!signature || expected !== signature) {
        console.warn("Webhook signature mismatch - rejecting");
        return res.status(400).send("Invalid signature");
      }
    } else {
      console.warn("No RAZORPAY_WEBHOOK_SECRET set in env — webhook signature verification skipped");
    }

    // parse event
    let event;
    try {
      event = JSON.parse(bodyStr);
    } catch (err) {
      console.warn("Webhook: failed to parse JSON body", err && err.message);
      return res.status(400).send("Invalid JSON");
    }

    console.log("📩 Razorpay webhook received:", event && event.event);

    // Handle a few important events (customize as needed)
    const evName = event && event.event;
    if (evName === "payment.captured") {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      console.log("✅ payment.captured:", payment && payment.id, "amount:", payment && payment.amount);
      // Optionally: trigger invoice generation / notify admin here
    } else if (evName === "payment.failed") {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      console.log("❌ payment.failed:", payment && payment.id, "error:", event.payload && event.payload.payment && event.payload.payment.error_code);
    } else if (evName === "order.paid") {
      console.log("order.paid event:", event.payload);
    } // add more events if you want

    // respond quickly
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Server error");
  }
});

// Health
app.get("/", (_req, res) => res.send("✅ Backend running. Use POST /create-order and POST /verify."));

const PORT = Number(safeEnv("PORT", 3000));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
