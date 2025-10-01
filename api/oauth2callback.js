const { google } = require('googleapis');
const crypto = require('crypto');

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function sign(value) {
  const h = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'change_me');
  h.update(value);
  return h.digest('base64url');
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const code = url.searchParams.get('code');
    if (!code) {
      res.statusCode = 400;
      return res.end('Missing code');
    }
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Lấy thông tin người dùng
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    tokens.user = {
      email: data.email || null,
      name: data.name || data.given_name || data.email || null,
      picture: data.picture || null
    };

    // Lưu token vào cookie (JSON + chữ ký HMAC)
    const payload = Buffer.from(JSON.stringify(tokens)).toString('base64url');
    const sig = sign(payload);
    const cookie = `sess=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${7*24*60*60}`;

    res.setHeader('Set-Cookie', cookie);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (e) {
    console.error('OAuth error:', e?.response?.data || e?.message || e);
    res.statusCode = 500;
    res.end('OAuth error');
  }
};
