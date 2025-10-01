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

module.exports = (req, res) => {
  const cookie = (req.headers.cookie || '')
    .split(';').map(s=>s.trim()).find(s=>s.startsWith('sess='))?.slice(5);
  const tokens = verify(cookie);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ authed: !!tokens, user: tokens?.user || null }));
};
