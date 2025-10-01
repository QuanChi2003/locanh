module.exports = (req, res) => {
  res.setHeader('Set-Cookie', 'sess=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
};
