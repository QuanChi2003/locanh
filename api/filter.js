const { google } = require('googleapis');
const crypto = require('crypto');

function verify(cookie) {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return null;
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'change_me')
    .update(payload).digest('base64url');
  if (mac !== sig) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }
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

/** Chuẩn hóa để so khớp “mềm”: bỏ đuôi, bỏ ký tự không chữ/số, không phân biệt hoa/thường */
function canon(s) {
  if (!s) return '';
  const base = s.replace(/\.[^.]+$/, '');
  return base.normalize('NFKC').replace(/[^0-9a-zA-Z]+/g, '').toUpperCase();
}

/** Map khóa chuẩn hóa -> danh sách file */
function buildCanonicalMap(files) {
  const m = new Map();
  for (const f of files) {
    const key = canon(f.name || '');
    if (!key) continue;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(f);
  }
  return m;
}

/** Làm sạch tên thư mục đích */
function sanitizeFolderName(name, fallback = 'Filtered') {
  const safe = String(name || '').trim()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  if (safe) return safe;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${fallback}_${ts}`;
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

    const jobName = body.jobName; // tên job do client gửi
    const sourceFolderLink = body.sourceFolderLink;
    const wantedRaw = normalizeList(body.list);
    const folderId = extractFolderIdFromUrl(sourceFolderLink);

    if (!folderId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Link thư mục Drive không hợp lệ' }));
    }
    if (!wantedRaw.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Danh sách trống' }));
    }

    // Drive client (có client_id/secret để refresh token)
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2 });

    // 1) List files (không đệ quy)
    let files = [];
    let pageToken = null;
    do {
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,thumbnailLink)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      files.push(...(resp.data.files || []));
      pageToken = resp.data.nextPageToken || null;
    } while (pageToken);

    const totalFiles = files.length;
    const byCanon = buildCanonicalMap(files);
    const wantedCanon = wantedRaw.map(canon);

    // 2) Tạo thư mục đích theo tên job
    const targetFolderName = sanitizeFolderName(jobName, 'Filtered');
    const folder = await drive.files.create({
      requestBody: {
        name: targetFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId]
      },
      fields: 'id',
      supportsAllDrives: true
    });
    const targetId = folder.data.id;

    // 3) Copy file khớp (mỗi mã có thể map đến nhiều file → copy tất cả)
    const matched = [];
    const notFound = [];
    for (let i = 0; i < wantedCanon.length; i++) {
      const key = wantedCanon[i];
      const rawLabel = wantedRaw[i];
      const group = byCanon.get(key);
      if (group && group.length) {
        for (const f of group) {
          if (!String(f.mimeType).startsWith('application/vnd.google-apps')) {
            await drive.files.copy({
              fileId: f.id,
              requestBody: { parents: [targetId], name: f.name },
              supportsAllDrives: true
            });
            matched.push({ name: f.name, thumbnailLink: f.thumbnailLink || null });
          }
        }
      } else {
        notFound.push(rawLabel);
      }
    }

    // 4) Share folder công khai để mở link được
    await drive.permissions.create({
      fileId: targetId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    const result = {
      ok: true,
      jobName: targetFolderName,
      resultLink: `https://drive.google.com/drive/folders/${targetId}`,
      matched,            // [{name, thumbnailLink}, ...]
      notFound,           // [string]
      totalFiles          // tổng số file đã quét trong thư mục nguồn
    };

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('Filter error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Server error', detail: err.message }));
  }
};
