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
app.post('/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amountPaise, // optional
      customer,    // optional
      cart,        // optional
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    // HMAC verification
    const expected = crypto
      .createHmac('sha256', safeEnv('RAZORPAY_KEY_SECRET') || '')
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Invalid signature' });
    }

    console.log('✅ Payment verified:', razorpay_order_id);

    // Generate PDF invoice
    const pdfPath = await makeInvoicePDFFile({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise: typeof amountPaise === 'number' ? amountPaise : undefined,
      customer: customer || {},
      cart: Array.isArray(cart) ? cart : [],
    });

    // Commit file to GitHub
    let githubResult = null;
    try {
      const owner = safeEnv('GITHUB_OWNER', 'chunariofficial12-boop');
      const repo = safeEnv('GITHUB_REPO', 'chunari-backend');
      const branch = safeEnv('GITHUB_BRANCH', 'main');
      const repoPath = `invoices/${path.basename(pdfPath)}`; // invoices/invoice-order_xxx.pdf

      githubResult = await uploadFileToGitHub({
        owner,
        repo,
        branch,
        path: repoPath,
        localFilePath: pdfPath,
        token: safeEnv('GITHUB_TOKEN'),
        commitMessage: `Add invoice for ${razorpay_order_id}`,
      });

      console.log('GitHub upload OK:', (githubResult && githubResult.commit && githubResult.commit.sha) || 'unknown-sha');
    } catch (ghErr) {
      console.error('GitHub upload error:', ghErr);
      // continue to try mailing anyway
    }

    // Email invoice to customer (if SMTP configured and customer email present)
    let mailInfo = null;
    try {
      const transporter = makeTransporter();
      const toEmail = (customer && customer.email) ? customer.email : null;
      if (transporter && toEmail) {
        const from = safeEnv('FROM_EMAIL') || safeEnv('SMTP_USER');
        const subject = safeEnv('INVOICE_EMAIL_SUBJECT') || 'Your Chunari Order Invoice (Thank you for shopping!)';
        const textBody = `Hello ${customer && customer.name ? customer.name : ''},\n\nThank you for your order. Please find attached your invoice (Order: ${razorpay_order_id}).\n\nRegards,\n${safeEnv('STORE_NAME','CHUNARI')}`;

        const mailOpts = {
          from,
          to: toEmail,
          subject,
          text: textBody,
          attachments: [
            { filename: path.basename(pdfPath), path: pdfPath, contentType: 'application/pdf' }
          ],
        };

        mailInfo = await transporter.sendMail(mailOpts);
        console.log('Email sent:', mailInfo && (mailInfo.messageId || mailInfo.response));
      } else {
        console.log('SMTP transporter missing or customer email not present - skipping email.');
      }
    } catch (mailErr) {
      console.error('Email send error:', mailErr);
    }

    // Cleanup: remove local PDF file
    try { await fsPromises.unlink(pdfPath); } catch (e) { /* ignore */ }

    // Build response
    const response = {
      ok: true,
      order: razorpay_order_id,
      payment: razorpay_payment_id,
      github: githubResult ? { commitSha: githubResult.commit && githubResult.commit.sha } : null,
      emailSent: !!mailInfo,
    };

    return res.json(response);
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Health
app.get('/', (_req, res) => res.send('✅ Backend running. Use POST /create-order and POST /verify.'));

const PORT = Number(safeEnv('PORT', 3000));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
