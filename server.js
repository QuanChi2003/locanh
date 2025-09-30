const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: 'replace-with-a-strong-secret',
  resave: false,
  saveUninitialized: true
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CONFIG ----------
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.warn('WARN: credentials.json not found. Create it from Google Cloud Console and place in project root.');
}
const credentials = fs.existsSync(CREDENTIALS_PATH) ? JSON.parse(fs.readFileSync(CREDENTIALS_PATH)) : null;

const CLIENT_ID = credentials?.web?.client_id || credentials?.installed?.client_id;
const CLIENT_SECRET = credentials?.web?.client_secret || credentials?.installed?.client_secret;
const REDIRECT_URI = (credentials?.web?.redirect_uris && credentials.web.redirect_uris[0]) || (credentials?.installed?.redirect_uris && credentials.installed?.redirect_uris[0]) || 'http://localhost:3000/oauth2callback';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

// ---------- OAuth helper ----------
function makeOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

app.get('/', (req, res) => {
  const loggedIn = !!req.session.tokens;
  res.render('index', { loggedIn });
});

app.get('/auth', (req, res) => {
  const oAuth2Client = makeOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code returned');
  const oAuth2Client = makeOAuthClient();
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error', err);
    res.status(500).send('Authentication error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- API: filter ----------
/**
 * POST /api/filter
 * body: { folderLink: string, codesText: string }
 *
 * NOTE: Matching will ignore file extension. Example:
 * - file name "38UT.CR2" -> basename "38UT"
 * - input code "38UT.CR2" or "38UT" -> compared as "38UT"
 */
app.post('/api/filter', async (req, res) => {
  try {
    if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated. Please sign in with Google.' });

    const { folderLink, codesText } = req.body;
    if (!folderLink) return res.status(400).json({ error: 'folderLink required' });
    if (!codesText) return res.status(400).json({ error: 'codesText required' });

    const folderId = extractFolderId(folderLink);
    if (!folderId) return res.status(400).json({ error: 'Could not extract folder ID from link' });

    const oAuth2Client = makeOAuthClient();
    oAuth2Client.setCredentials(req.session.tokens);
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    // parse codes and normalize to basename (strip extension if any), lowercase
    const codes = codesText
      .split(/[\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => basenameOf(s).toLowerCase());

    // list files in the folder (non-recursive)
    const files = await listFilesInFolder(drive, folderId);

    // create a map from basename -> fileObj (keep first encountered file for that basename)
    const mapBaseToFile = {};
    for (const f of files) {
      if (!f.name) continue;
      const base = basenameOf(f.name).toLowerCase();
      if (!mapBaseToFile[base]) {
        mapBaseToFile[base] = f;
      }
    }

    // find matches by basename
    const matched = [];
    for (const codeBase of codes) {
      if (mapBaseToFile[codeBase]) matched.push(mapBaseToFile[codeBase]);
    }

    if (matched.length === 0) {
      return res.json({ message: 'No files matched', createdFolderId: null, links: [] });
    }

    // create new subfolder inside the original folder
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const newFolderName = `filtered-${timestamp}`;
    const createRes = await drive.files.create({
      requestBody: {
        name: newFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId]
      },
      fields: 'id,name'
    });
    const newFolderId = createRes.data.id;

    // copy matched files into new folder and set sharing to anyoneWithLink
    const links = [];
    for (const f of matched) {
      const copyRes = await drive.files.copy({
        fileId: f.id,
        requestBody: {
          name: f.name,
          parents: [newFolderId]
        },
        fields: 'id, name'
      });
      const newFileId = copyRes.data.id;

      await drive.permissions.create({
        fileId: newFileId,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });

      const meta = await drive.files.get({
        fileId: newFileId,
        fields: 'id, name, webViewLink, webContentLink'
      });

      links.push({
        originalName: f.name,
        newFileId,
        webViewLink: meta.data.webViewLink || null,
        webContentLink: meta.data.webContentLink || null
      });
    }

    res.json({ message: 'Done', createdFolderId: newFolderId, createdFolderName: newFolderName, links });
  } catch (err) {
    console.error('Filter error', err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- helper functions ----------
function extractFolderId(link) {
  const m1 = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(link)) return link;
  return null;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageToken: pageToken || undefined,
      pageSize: 1000
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

function basenameOf(filename) {
  if (!filename) return filename;
  // find last dot (.) — everything before that is basename
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) {
    // no dot or dot at start -> return whole name
    return filename;
  }
  return filename.substring(0, idx);
}

// ---------- Views & static ----------
app.get('/profile', (req, res) => {
  if (!req.session.tokens) return res.redirect('/');
  res.send(`<p>Logged in. <a href="/">Back</a> | <a href="/logout">Logout</a></p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Drive Filterer running on http://localhost:${PORT}`);
});