// driveUploader.js
const { google } = require('googleapis');
const { Readable } = require('stream');

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'], // enough for uploads to the shared folder
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Upload a PDF buffer to Google Drive folder
 * @param {Buffer} pdfBuffer - The PDF content
 * @param {string} filename - e.g. "INV-1001.pdf"
 * @returns {Promise<{id: string, webViewLink: string, name: string}>}
 */
async function uploadPdfToDrive(pdfBuffer, filename) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType: 'application/pdf',
    },
    media: {
      mimeType: 'application/pdf',
      body: Readable.from(pdfBuffer),
    },
    fields: 'id, name, webViewLink',
  });

  // Make sure the file inherits the folder’s access (no extra perms needed)
  return res.data;
}

module.exports = { uploadPdfToDrive };
