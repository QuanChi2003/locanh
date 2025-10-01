import { google } from "googleapis";

let tokens = null; // lưu token tạm (chỉ 1 user)

export default async function handler(req, res) {
  const { code } = req.query;

  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    `${process.env.BASE_URL}/api/oauth2callback`
  );

  const { tokens: t } = await oAuth2Client.getToken(code);
  tokens = t;
  res.send("<h3>✅ Đăng nhập thành công! Giờ quay lại trang chính để lọc ảnh.</h3><a href='/'>Quay lại</a>");
}

export function getTokens() {
  return tokens;
}
