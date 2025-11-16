// utils/githubUploader.js
// Small helper to create/update a file in a GitHub repo using a PAT (GITHUB_TOKEN).
// Usage: const { uploadFileToGitHub } = require('./utils/githubUploader');
// await uploadFileToGitHub({ owner, repo, branch, path, localFilePath, token, commitMessage });

const fs = require('fs').promises;
const path = require('path');

async function _fetch(...args) {
  // node >=18 has global fetch. If not, try to require node-fetch.
  if (typeof fetch !== 'undefined') return fetch(...args);
  try {
    // eslint-disable-next-line global-require
    const nodeFetch = require('node-fetch');
    return nodeFetch(...args);
  } catch (e) {
    throw new Error('fetch is not available. Please run on Node 18+ or add node-fetch dependency.');
  }
}

function base64Encode(buffer) {
  if (Buffer.isBuffer(buffer)) return buffer.toString('base64');
  if (typeof buffer === 'string') return Buffer.from(buffer).toString('base64');
  // if it's a Uint8Array:
  return Buffer.from(buffer).toString('base64');
}

/**
 * Upload (create or update) a file to GitHub repository.
 *
 * @param {Object} opts
 * @param {string} opts.owner - github owner (user/org)
 * @param {string} opts.repo  - repo name
 * @param {string} opts.branch - branch name (e.g. "main")
 * @param {string} opts.path - path in repo including file name e.g. "invoices/invoice-XXX.pdf"
 * @param {string} [opts.localFilePath] - local path on the server (one of localFilePath or contentBuffer required)
 * @param {Buffer|string} [opts.contentBuffer] - file buffer or string
 * @param {string} opts.token - GITHUB_TOKEN (PAT) with public_repo or repo scope
 * @param {string} opts.commitMessage - commit message
 *
 * @returns {Object} GitHub API response JSON
 */
async function uploadFileToGitHub({
  owner,
  repo,
  branch = 'main',
  path: repoPath,
  localFilePath,
  contentBuffer,
  token,
  commitMessage = 'Add invoice file',
}) {
  if (!owner || !repo || !repoPath || !token) {
    throw new Error('owner, repo, path and token are required');
  }

  // read file if local path provided
  let buffer;
  if (localFilePath) {
    const resolved = path.resolve(localFilePath);
    buffer = await fs.readFile(resolved);
  } else if (contentBuffer) {
    buffer = contentBuffer;
  } else {
    throw new Error('Either localFilePath or contentBuffer must be provided');
  }

  const contentBase64 = base64Encode(buffer);

  const apiBase = 'https://api.github.com';
  const fileUrl = `${apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(repoPath)}`;

  // First: check if file already exists to obtain sha (for update)
  let sha;
  try {
    const r = await _fetch(`${fileUrl}?ref=${encodeURIComponent(branch)}`, {
      method: 'GET',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'chunari-invoice-uploader',
      },
    });

    if (r.status === 200) {
      const j = await r.json();
      if (j && j.sha) sha = j.sha;
    } else if (r.status !== 404) {
      // if it's not found (404) it's ok; otherwise log for debugging
      const txt = await r.text();
      throw new Error(`Failed to check file: ${r.status} ${txt}`);
    }
  } catch (err) {
    throw new Error('Error checking existing file: ' + err.message);
  }

  // Build payload
  const payload = {
    message: commitMessage,
    content: contentBase64,
    branch,
  };
  if (sha) payload.sha = sha;

  // Create or update
  const resp = await _fetch(fileUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'chunari-invoice-uploader',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const resJson = await resp.json();
  if (!resp.ok) {
    throw new Error(`GitHub upload failed: ${resp.status} ${JSON.stringify(resJson)}`);
  }

  return resJson; // contains content, commit, etc.
}

module.exports = {
  uploadFileToGitHub,
};
