// server.js - simplified: Razorpay + Invoice PDF + GitHub commit + SMTP email
require("dotenv").config();
const { uploadFileToGitHub } = require("./utils/githubUploader");


const crypto = require("crypto");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");

const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

// GitHub uploader module (you created utils/githubUploader.js)
const { uploadFileToGitHub } = require('./utils/githubUploader');

// ---------- Helpers ----------
const TMP_DIR = "/tmp/invoices";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const moneyFromPaise = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;

function safeEnv(name, fallback = undefined) {
  return process.env[name] || fallback;
}

// Create invoice PDF on disk and return file path
function makeInvoicePDFFile({ orderId, paymentId, amountPaise, customer = {}, cart = [] }) {
  return new Promise((resolve, reject) => {
    const fileName = `invoice-order_${orderId}.pdf`;
    const filePath = path.join(TMP_DIR, fileName);
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const storeName = safeEnv('STORE_NAME', 'Your Store');
    const storeEmail = safeEnv('STORE_EMAIL', '');
    const storePhone = safeEnv('STORE_PHONE', '');
    const storeAddress = safeEnv('STORE_ADDRESS', '');

    // Header
    doc.fontSize(20).text(storeName, { align: 'left' }).moveDown(0.2)
      .fontSize(10)
      .text(storeAddress)
      .text(`Phone: ${storePhone}`)
      .text(`Email: ${storeEmail}`)
      .moveDown();

    doc.fontSize(16).text('INVOICE', { align: 'right' })
      .fontSize(10)
      .text(`Date: ${new Date().toLocaleString()}`, { align: 'right' })
      .text(`Order ID: ${orderId}`, { align: 'right' })
      .text(`Payment ID: ${paymentId || '-'}`, { align: 'right' })
      .moveDown();

    // Bill to
    doc.fontSize(12).text('Bill To', { underline: true }).fontSize(10)
      .text(customer.name || '')
      .text(customer.address1 || '')
      .text(customer.address2 || '')
      .text([customer.city, customer.state, customer.pincode].filter(Boolean).join(', '))
      .text(`Phone: ${customer.phone || ''}`)
      .text(`Email: ${customer.email || ''}`)
      .moveDown();

    // Items
    doc.fontSize(11).text('Items:', { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    const colX = [40, 300, 380];
    doc.text('Item', colX[0], doc.y);
    doc.text('Qty x Price', colX[1], doc.y);
    doc.text('Amount', colX[2], doc.y);
    doc.moveDown(0.2);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();

    let subtotal = 0;
    (cart || []).forEach((it) => {
      const qty = Number(it.qty || 1);
      const price = Number(it.price || 0);
      const amount = qty * price;
      subtotal += amount;

      doc.moveDown(0.3);
      doc.text(it.name || '', colX[0], doc.y);
      doc.text(`${qty} x ₹${price.toFixed(2)}`, colX[1], doc.y);
      doc.text(`₹${amount.toFixed(2)}`, colX[2], doc.y);
    });

    // If cart empty, show total from amountPaise
    if (!(cart && cart.length)) {
      const totalRs = (typeof amountPaise === 'number') ? (amountPaise / 100) : 0;
      subtotal = totalRs;
    }

    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(570, doc.y).stroke();
    doc.moveDown(0.5);
    doc.text(`Subtotal: ₹${subtotal.toFixed(2)}`, { align: 'right' });
    doc.text(`Tax (GST not registered): ₹0.00`, { align: 'right' });
    if (typeof amountPaise === 'number') {
      doc.text(`Total Paid: ${moneyFromPaise(amountPaise)}`, { align: 'right' });
    }

    doc.moveDown(1);
    doc.fontSize(9).text('Note: GST not registered. This is a computer-generated invoice.');

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', (err) => reject(err));
  });
}

// Setup nodemailer transporter (SMTP)
function makeTransporter() {
  const host = safeEnv('SMTP_HOST');
  const port = Number(safeEnv('SMTP_PORT', 587));
  const user = safeEnv('SMTP_USER');
  const pass = safeEnv('SMTP_PASS');

  if (!host || !user || !pass) {
    return null; // caller will handle missing transporter
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: { user, pass },
  });
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: safeEnv('RAZORPAY_KEY_ID'),
  key_secret: safeEnv('RAZORPAY_KEY_SECRET'),
});

// Create order
app.post('/create-order', async (req, res) => {
  try {
    const amount = Number(req.body.amount); // paise
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount (paise) is required and must be > 0' });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      payment_capture: 1,
    });

    res.json(order);
  } catch (error) {
    console.error('create-order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Verify payment, generate invoice, commit to GitHub, and email customer
app.post("/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amountPaise,
      customer,
      cart
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    // Verify Razorpay signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ ok: false, error: "Invalid signature" });
    }

    console.log("✅ Payment verified:", razorpay_order_id);

    // Create PDF invoice locally
    const pdfPath = await makeInvoicePDFFile({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise,
      customer,
      cart
    });

    // Upload PDF to GitHub
    const githubResponse = await uploadFileToGitHub({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      branch: process.env.GITHUB_BRANCH || "main",
      path: `invoices/invoice_${razorpay_order_id}.pdf`,
      localFilePath: pdfPath,
      token: process.env.GITHUB_TOKEN,
      commitMessage: `Invoice for order ${razorpay_order_id}`
    });

    // Send Email with invoice attachment
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.FROM_EMAIL,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: customer.email,
      bcc: process.env.BCC_EMAIL,
      subject: `Your CHUNARI Order Invoice - ${razorpay_order_id}`,
      text: `Thank you for your order!\nYour invoice is attached.\n\nOrder ID: ${razorpay_order_id}`,
      attachments: [
        {
          filename: `invoice_${razorpay_order_id}.pdf`,
          path: pdfPath
        }
      ]
    });

    return res.json({
      ok: true,
      message: "Invoice generated, uploaded, and emailed.",
      github: githubResponse
    });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

