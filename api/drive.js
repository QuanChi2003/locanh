const serverless = require('serverless-http');
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const cookieSession = require('cookie-session');

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.use(cookieSession({
  name: 'sess',
  keys: [process.env.SESSION_SECRET],
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function extractFolderIdFromUrl(url) {
  if (!url) return null;
  const m1 = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

function normalizeList(input) {
  return input.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function buildNameMaps(files) {
  const exact = new Map();
  const base = new Map();
  for (const f of files) {
    const lower = f.name.toLowerCase();
    exact.set(lower, f);
    const baseName = lower.split('.')[0];
    if (!base.has(baseName)) base.set(baseName, []);
    base.get(baseName).push(f);
  }
  return { exact, base };
}

function getDrive(req) {
  if (!req.session?.tokens) return null;
  const c = makeOAuthClient();
  c.setCredentials(req.session.tokens);
  return google.drive({ version: 'v3', auth: c });
}

app.get('/api/auth', (req, res) => {
  const url = makeOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  res.redirect(url);
});

app.get('/api/oauth2callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code');
    const { tokens } = await makeOAuthClient().getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth error');
  }
});

app.get('/api/me', (req, res) => {
  res.json({ authed: !!req.session?.tokens });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.post('/api/filter', async (req, res) => {
  try {
    if (!req.session?.tokens) return res.status(401).json({ error: 'Chưa đăng nhập' });
    const { sourceFolderLink, list } = req.body;
    const folderId = extractFolderIdFromUrl(sourceFolderLink);
    if (!folderId) return res.status(400).json({ error: 'Link không hợp lệ' });

    const wanted = normalizeList(list);
    if (!wanted.length) return res.status(400).json({ error: 'Danh sách trống' });

    const drive = getDrive(req);
    let files = [];
    let pageToken = null;
    do {
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      files.push(...(resp.data.files || []));
      pageToken = resp.data.nextPageToken;
    } while (pageToken);

    const maps = buildNameMaps(files);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const newFolder = await drive.files.create({
      requestBody: {
        name: `Filtered_${ts}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId]
      },
      fields: 'id',
      supportsAllDrives: true
    });
    const targetId = newFolder.data.id;

    const matched = [], notFound = [];
    for (const raw of wanted) {
      const lower = raw.toLowerCase();
      const file = maps.exact.get(lower);
      if (file && !file.mimeType.startsWith('application/vnd.google-apps')) {
        await drive.files.copy({
          fileId: file.id,
          requestBody: { parents: [targetId], name: file.name },
          supportsAllDrives: true
        });
        matched.push(file.name);
      } else {
        notFound.push(raw);
      }
    }

    await drive.permissions.create({
      fileId: targetId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    res.json({
      ok: true,
      resultLink: `https://drive.google.com/drive/folders/${targetId}`,
      matched, notFound
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

module.exports = serverless(app);
