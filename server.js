// server.js (minimal, production-friendly)

require("dotenv").config();

// ── Core ────────────────────────────────────────────────────────
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Server libs ────────────────────────────────────────────────
const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");

// ── Invoice ────────────────────────────────────────────────────
const PDFDocument = require("pdfkit");

// ── Google Drive (Service Account) ─────────────────────────────
const { google } = require("googleapis");

// --- Read Google credentials from env (JSON or base64) ---
let rawCreds =
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
  process.env.GOOGLE_CREDENTIALS;

if (!rawCreds && process.env.GOOGLE_CREDENTIALS_B64) {
  rawCreds = Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, "base64").toString("utf8");
}
if (!rawCreds) {
  throw new Error(
    "Missing Google creds. Set GOOGLE_APPLICATION_CREDENTIALS_JSON (preferred) or GOOGLE_CREDENTIALS or GOOGLE_CREDENTIALS_B64."
  );
}

let GOOGLE_KEY;
try {
  GOOGLE_KEY = JSON.parse(rawCreds);
} catch (e) {
  throw new Error("Google credentials env is not valid JSON (or decoded base64).");
}

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_KEY,
  scopes: ["https://www.googleapis.com/auth/drive.file"], // upload to user's shared folder
});
const drive = google.drive({ version: "v3", auth });

// ── Helpers ────────────────────────────────────────────────────
const TMP_DIR = "/tmp/invoices";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const moneyFromPaise = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;

// Create invoice PDF on disk and return file path
function makeInvoicePDFFile({ orderId, paymentId, amountPaise, customer, cart = [] }) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(TMP_DIR, `invoice-${orderId}.pdf`);
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Store info from env (optional)
    const storeName = process.env.STORE_NAME || "Your Store";
    const storeEmail = process.env.STORE_EMAIL || "";
    const storePhone = process.env.STORE_PHONE || "";
    const storeAddress = process.env.STORE_ADDRESS || "";

    // Header
    doc
      .fontSize(20)
      .text(storeName, { align: "left" })
      .moveDown(0.2)
      .fontSize(10)
      .text(storeAddress)
      .text(`Phone: ${storePhone}`)
      .text(`Email: ${storeEmail}`)
      .moveDown();

    doc
      .fontSize(16)
      .text("INVOICE", { align: "right" })
      .fontSize(10)
      .text(`Date: ${new Date().toLocaleString()}`, { align: "right" })
      .text(`Order ID: ${orderId}`, { align: "right" })
      .text(`Payment ID: ${paymentId || "-"}`, { align: "right" })
      .moveDown();

    // Bill to
    doc
      .fontSize(12)
      .text("Bill To", { underline: true })
      .fontSize(10)
      .text(customer?.name || "")
      .text(customer?.address1 || "")
      .text(customer?.address2 || "")
      .text(
        [customer?.city, customer?.state, customer?.pincode].filter(Boolean).join(", ")
      )
      .text(`Phone: ${customer?.phone || ""}`)
      .text(`Email: ${customer?.email || ""}`)
      .moveDown();

    // Items
    doc.fontSize(11).text("Items:", { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    const colX = [40, 260, 360, 430];
    doc.text("Item", colX[0], doc.y);
    doc.text("Qty", colX[1], doc.y);
    doc.text("Price", colX[2], doc.y);
    doc.text("Amount", colX[3], doc.y);
    doc.moveDown(0.2);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();

    let sub = 0;
    (cart || []).forEach((it) => {
      const qty = Number(it.qty || 1);
      const price = Number(it.price || 0);
      const line = qty * price;
      sub += line;

      doc.moveDown(0.3);
      doc.text(it.name || "", colX[0], doc.y);
      doc.text(String(qty), colX[1], doc.y);
      doc.text(`₹${price.toFixed(2)}`, colX[2], doc.y);
      doc.text(`₹${line.toFixed(2)}`, colX[3], doc.y);
    });

    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();
    doc.moveDown(0.5);
    doc.text(`Subtotal: ₹${sub.toFixed(2)}`, { align: "right" });
    doc.text(`Tax (GST not registered): ₹0.00`, { align: "right" });

    if (typeof amountPaise === "number") {
      doc.text(`Total Paid: ${moneyFromPaise(amountPaise)}`, { align: "right" });
    }

    doc.moveDown(1);
    doc.fontSize(9).text("Note: GST not registered. This is a computer-generated invoice.");

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

async function uploadToDrive(filePath, fileName) {
  const fileMetadata = {
    name: fileName,
    parents: process.env.GOOGLE_DRIVE_FOLDER_ID ? [process.env.GOOGLE_DRIVE_FOLDER_ID] : undefined,
  };
  const media = { mimeType: "application/pdf", body: fs.createReadStream(filePath) };

  const res = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id, webViewLink",
  });

  // Optional: clean up the temp file
  try { fs.unlinkSync(filePath); } catch (_) {}

  return res.data; // { id, webViewLink }
}

// ── App + Razorpay ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create order (amount in paise)
app.post("/create-order", async (req, res) => {
  try {
    const amount = Number(req.body.amount); // paise
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Amount (paise) is required and must be > 0" });
    }

    // You can pass customer/cart back later in /verify
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

// Verify payment + generate/upload invoice
app.post("/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      // Send these from frontend when payment is successful:
      amountPaise,        // number (optional, but recommended)
      customer,           // {name, email, phone, address1, address2, city, state, pincode}
      cart,               // [{name, qty, price}, ...]
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    // HMAC verification
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Invalid signature" });
    }

    console.log("✅ Payment verified:", razorpay_order_id);

    // Build invoice (use amountPaise if provided)
    const pdfPath = await makeInvoicePDFFile({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise: typeof amountPaise === "number" ? amountPaise : undefined,
      customer: customer || {},
      cart: Array.isArray(cart) ? cart : [],
    });

    const uploaded = await uploadToDrive(pdfPath, `invoice-${razorpay_order_id}.pdf`);

    return res.json({
      ok: true,
      driveFileId: uploaded.id,
      driveViewLink: uploaded.webViewLink,
    });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health
app.get("/", (_req, res) =>
  res.send("✅ Backend running. Use POST /create-order and POST /verify.")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
