// utils/githubUploader.js
// Upload (create or update) a file to GitHub repository using a PAT (GITHUB_TOKEN).
// Usage: const { uploadFileToGitHub } = require('./utils/githubUploader');
// await uploadFileToGitHub({ owner, repo, branch, path, localFilePath, token, commitMessage });

const fs = require('fs').promises;
const path = require('path');

async function _fetch(...args) {
  // node >=18 has global fetch. If not, try node-fetch.
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
  // Uint8Array, ArrayBuffer, etc.
  return Buffer.from(buffer).toString('base64');
}

/** small helper to run fetch with timeout */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;
  const finalOpts = { ...opts, signal };

  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await _fetch(url, finalOpts);
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** lightweight retry wrapper for async fn */
async function retry(fn, tries = 3, delayMs = 700) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 1.5;
      }
    }
  }
  throw lastErr;
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
 * @param {Buffer|Uint8Array|string} [opts.contentBuffer] - file buffer or string
 * @param {string} opts.token - GITHUB_TOKEN (PAT) with repo or public_repo scope
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
  commitMessage = 'Add file',
}) {
  if (!owner || !repo || !repoPath || !token) {
    throw new Error('owner, repo, path and token are required');
  }

  // normalize repoPath (no leading slash)
  repoPath = String(repoPath).replace(/^\/+/, '');

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
  const fileUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(
    repoPath
  )}`;

  const commonHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'chunari-invoice-uploader',
  };

  // First: check if file already exists to obtain sha (for update)
  let sha;
  try {
    const check = await retry(
      async () => {
        const r = await fetchWithTimeout(`${fileUrl}?ref=${encodeURIComponent(branch)}`, { method: 'GET', headers: commonHeaders }, 10000);
        // 200 => exists, 404 => not found (fine), other => treat as error
        if (r.status === 200) {
          const j = await r.json();
          if (j && j.sha) sha = j.sha;
          return j;
        }
        if (r.status === 404) {
          return null;
        }
        // try to include body text in error
        let txt;
        try {
          txt = await r.text();
        } catch (_) {
          txt = `<no-body>`;
        }
        throw new Error(`GitHub GET status ${r.status}: ${txt}`);
      },
      3,
      600
    );
    // check variable handled inside
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

  // Create or update (with retry)
  try {
    const res = await retry(
      async () => {
        const r = await fetchWithTimeout(
          fileUrl,
          {
            method: 'PUT',
            headers: {
              ...commonHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
          20000
        );
        const resJson = await r.json();
        if (!r.ok) {
          throw new Error(`GitHub upload failed: ${r.status} ${JSON.stringify(resJson)}`);
        }
        return resJson;
      },
      3,
      800
    );
    return res;
  } catch (err) {
    throw new Error('GitHub upload failed: ' + (err.message || String(err)));
  }
}

module.exports = {
  uploadFileToGitHub,
};
