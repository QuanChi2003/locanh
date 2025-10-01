const { google } = require('googleapis');
const crypto = require('crypto');

function verify(cookie) {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return null;
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'change_me')
    .update(payload).digest('base64url');
  if (mac !== sig) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch { return null; }
}

function extractFolderIdFromUrl(url) {
  if (!url) return null;
  const m1 = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

function normalizeList(input) {
  return String(input || '')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function buildNameMap(files) {
  const m = new Map();
  for (const f of files) m.set((f.name || '').toLowerCase(), f);
  return m;
}

module.exports = async (req, res) => {
  try {
    // Parse body
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    // Auth
    const cookieRaw = (req.headers.cookie || '')
      .split(';').map(s=>s.trim()).find(s=>s.startsWith('sess='))?.slice(5);
    const tokens = verify(cookieRaw);
    if (!tokens) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'Chưa đăng nhập' }));
    }

    const sourceFolderLink = body.sourceFolderLink;
    const wanted = normalizeList(body.list);
    const folderId = extractFolderIdFromUrl(sourceFolderLink);

    if (!folderId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Link thư mục Drive không hợp lệ' }));
    }
    if (!wanted.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Danh sách trống' }));
    }

    // Drive client
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2 });

    // 1) List files (không đệ quy)
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
      pageToken = resp.data.nextPageToken || null;
    } while (pageToken);

    const byName = buildNameMap(files);

    // 2) Create target folder
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = await drive.files.create({
      requestBody: {
        name: `Filtered_${ts}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId]
      },
      fields: 'id',
      supportsAllDrives: true
    });
    const targetId = folder.data.id;

    // 3) Copy matched
    const matched = [];
    const notFound = [];
    for (const raw of wanted) {
      const f = byName.get(raw.toLowerCase());
      if (f && !String(f.mimeType).startsWith('application/vnd.google-apps')) {
        await drive.files.copy({
          fileId: f.id,
          requestBody: { parents: [targetId], name: f.name },
          supportsAllDrives: true
        });
        matched.push(f.name);
      } else {
        notFound.push(raw);
      }
    }

    // 4) Share folder
    await drive.permissions.create({
      fileId: targetId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    const result = {
      ok: true,
      resultLink: `https://drive.google.com/drive/folders/${targetId}`,
      matched,
      notFound
    };

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('Filter error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Server error', detail: err.message }));
  }
};
