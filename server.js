// --- Core & security ---
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// --- Server libs ---
const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");

// --- Invoice + time ---
const PDFDocument = require("pdfkit");
const dayjs = require("dayjs");

// ────────────────────────────────────────────────────────────────
// Very simple storage (append-only files + in-memory index)
// ────────────────────────────────────────────────────────────────
const ORDERS_FILE   = path.join(__dirname, "orders_store.jsonl");
const VERIFIED_FILE = path.join(__dirname, "payments_verified.txt");

if (!fs.existsSync(ORDERS_FILE))   fs.writeFileSync(ORDERS_FILE, "");
if (!fs.existsSync(VERIFIED_FILE)) fs.writeFileSync(VERIFIED_FILE, "");

const orderIndex = new Map(); // orderId -> {amountPaise,currency,customer,cart,created_at}

(function indexExistingOrders() {
  try {
    const data = fs.readFileSync(ORDERS_FILE, "utf8");
    data.split("\n").filter(Boolean).forEach(line => {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.orderId) orderIndex.set(obj.orderId, obj);
      } catch (_) {}
    });
  } catch (_) {}
})();

function appendOrderRecord(record) {
  try {
    fs.appendFileSync(ORDERS_FILE, JSON.stringify(record) + "\n");
    orderIndex.set(record.orderId, record);
  } catch (e) {
    console.error("appendOrderRecord error:", e.message);
  }
}

// ────────────────────────────────────────────────────────────────
function moneyFromPaise(paise) {
  return `₹${(Number(paise || 0) / 100).toFixed(2)}`;
}

/** Create invoice PDF in memory. Returns Buffer. */
function makeInvoiceBuffer({ orderId, paymentId, amountPaise, customer, cart = [] }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 40 });
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const storeName    = process.env.STORE_NAME    || "Your Store";
    const storeEmail   = process.env.STORE_EMAIL   || "";
    const storePhone   = process.env.STORE_PHONE   || "";
    const storeAddress = process.env.STORE_ADDRESS || "";

    // Header
    doc.fontSize(20).text(storeName, { align: "left" })
      .moveDown(0.2)
      .fontSize(10)
      .text(storeAddress)
      .text(`Phone: ${storePhone}`)
      .text(`Email: ${storeEmail}`)
      .moveDown();

    doc.fontSize(16).text("INVOICE", { align: "right" })
      .fontSize(10)
      .text(`Date: ${dayjs().format("DD MMM YYYY, HH:mm")}`, { align: "right" })
      .text(`Order ID: ${orderId}`, { align: "right" })
      .text(`Payment ID: ${paymentId}`, { align: "right" })
      .moveDown();

    // Bill to
    doc.fontSize(12).text("Bill To", { underline: true })
      .fontSize(10)
      .text(customer?.name || "")
      .text(customer?.address1 || "")
      .text(customer?.address2 || "")
      .text(`${customer?.city || ""}, ${customer?.state || ""} - ${customer?.pincode || ""}`)
      .text(`Phone: ${customer?.phone || ""}`)
      .text(`Email: ${customer?.email || ""}`)
      .moveDown();

    // Items
    doc.fontSize(11).text("Items:", { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    const colX = [40, 260, 360, 430]; // item, qty, price, amount
    doc.text("Item",   colX[0], doc.y);
    doc.text("Qty",    colX[1], doc.y);
    doc.text("Price",  colX[2], doc.y);
    doc.text("Amount", colX[3], doc.y);
    doc.moveDown(0.2);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();

    let sub = 0;
    (cart || []).forEach(it => {
      const qty   = Number(it.qty || 1);
      const price = Number(it.price || 0);
      const line  = qty * price;
      sub += line;

      doc.moveDown(0.3);
      doc.text(it.name || "",    colX[0], doc.y);
      doc.text(String(qty),      colX[1], doc.y);
      doc.text(`₹${price.toFixed(2)}`, colX[2], doc.y);
      doc.text(`₹${line.toFixed(2)}`,  colX[3], doc.y);
    });

    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();

    doc.moveDown(0.5);
    doc.text(`Subtotal: ₹${sub.toFixed(2)}`, { align: "right" });
    doc.text(`Tax (GST not registered): ₹0.00`, { align: "right" });
    doc.text(`Total Paid: ${amountPaise ? moneyFromPaise(amountPaise) : "Paid"}`, { align: "right" });

    doc.moveDown(1);
    doc.fontSize(9).text("Note: GST not registered. This is a computer-generated invoice.");

    doc.end();
  });
}

/** Send email via Resend API (https/443 works on Render). */
async function sendInvoiceViaResend({ to, subject, html, filename, buffer }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY missing");

  const base64 = buffer ? buffer.toString("base64") : undefined;

  const payload = {
    from: process.env.FROM_EMAIL || "onboarding@resend.dev",
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    bcc: process.env.BCC_EMAIL ? [process.env.BCC_EMAIL] : undefined,
    attachments: base64
      ? [{ filename: filename || "invoice.pdf", content: base64 }]
      : undefined,
  };

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Resend error ${r.status}: ${text}`);
  }
  return r.json();
}

// ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Debug (remove in prod)
console.log("KEY_ID:", process.env.RAZORPAY_KEY_ID);
console.log("KEY_SECRET:", process.env.RAZORPAY_KEY_SECRET ? "**** loaded" : "NOT LOADED");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create order
app.post("/create-order", async (req, res) => {
  try {
    const amount = Number(req.body.amount); // paise
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Amount (in paise) is required" });
    }

    const customer = req.body.customer || {};
    const cart     = Array.isArray(req.body.cart) ? req.body.cart : [];

    const notes = {
      customer_name:  (customer.name    || "NA").toString().slice(0, 100),
      customer_phone: (customer.phone   || "NA").toString().slice(0, 20),
      customer_email: (customer.email   || "NA").toString().slice(0, 100),
      address_line1:  (customer.address1|| "NA").toString().slice(0, 120),
      address_line2:  (customer.address2|| ""  ).toString().slice(0, 120),
      city:           (customer.city    || ""  ).toString().slice(0, 60),
      state:          (customer.state   || ""  ).toString().slice(0, 60),
      pincode:        (customer.pincode || ""  ).toString().slice(0, 20),
    };

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
      payment_capture: 1,
      notes,
    });

    appendOrderRecord({
      orderId: order.id,
      amountPaise: amount,
      currency: "INR",
      customer,
      cart,
      created_at: new Date().toISOString(),
    });

    console.log("🧾 New Order:", order.id, "-", order.amount, order.currency);
    res.json(order);
  } catch (error) {
    console.error("❌ create-order error:", error.message);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// Verify + send invoice
app.post("/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer, cart } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expected !== razorpay_signature) {
      console.log("❌ Payment verification failed");
      return res.status(400).json({ ok: false });
    }

    console.log("✅ Payment verified:", { razorpay_order_id, razorpay_payment_id });

    // Persist verification
    try {
      fs.appendFileSync(
        VERIFIED_FILE,
        JSON.stringify({
          razorpay_order_id,
          razorpay_payment_id,
          verified_at: new Date().toISOString(),
        }) + "\n"
      );
    } catch (_) {}

    // Load order details
    let orderData = orderIndex.get(razorpay_order_id) || {
      orderId: razorpay_order_id,
      amountPaise: undefined,
      currency: "INR",
      customer: customer || {},
      cart: cart || [],
      created_at: new Date().toISOString(),
    };

    const payload = {
      orderId:    orderData.orderId || razorpay_order_id,
      paymentId:  razorpay_payment_id,
      amountPaise: orderData.amountPaise,
      customer:   orderData.customer || customer || {},
      cart:       orderData.cart && orderData.cart.length ? orderData.cart : (cart || []),
    };

    // Generate invoice PDF in memory
    const pdfBuffer = await makeInvoiceBuffer(payload);

    // Email via Resend
    try {
      await sendInvoiceViaResend({
        to: (payload.customer && payload.customer.email) || process.env.STORE_EMAIL,
        subject: `Invoice for your ${process.env.STORE_NAME || "Order"} ${payload.orderId}`,
        html: `
          <p>Hi ${payload.customer?.name || "there"},</p>
          <p>Thanks for your purchase! Your invoice is attached.</p>
          <p><b>Order ID:</b> ${payload.orderId}<br/>
             <b>Payment ID:</b> ${payload.paymentId}<br/>
             <b>Amount:</b> ${payload.amountPaise ? moneyFromPaise(payload.amountPaise) : "Paid"}</p>
          <p>— ${process.env.STORE_NAME || "Our Store"}</p>
        `,
        filename: `invoice-${payload.orderId}.pdf`,
        buffer: pdfBuffer,
      });
      console.log("📧 Resend: invoice email queued.");
      return res.json({ ok: true, emailed: true });
    } catch (emailErr) {
      console.error("Email send failed:", emailErr.message);
      return res.json({ ok: true, emailed: false });
    }
  } catch (err) {
    console.error("❌ Verify error:", err.message);
    res.status(500).json({ ok: false, error: "Verification error" });
  }
});

// Health route
app.get("/", (_req, res) => {
  res.send("✅ Razorpay backend is running. Use POST /create-order and POST /verify.");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
