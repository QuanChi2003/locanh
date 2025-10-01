import express from "express";
import { google } from "googleapis";
import bodyParser from "body-parser";
import path from "path";

const app = express();
app.use(bodyParser.json());
app.use(express.static(".")); // phục vụ index.html

// OAuth2 config
const CLIENT_ID = "598650572631-celek24b63ekm82860gr4r53dq5sqsrh.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3000/oauth2callback";

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Đăng nhập Google
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive"],
  });
  res.redirect(url);
});

// Callback login
app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  res.sendFile(path.resolve("index.html")); // quay lại trang chính
});

// API lọc ảnh
app.post("/filter", async (req, res) => {
  try {
    const { folderId, fileCodes } = req.body;
    const drive = google.drive({ version: "v3", auth: oAuth2Client });

    // Tạo folder con
    const newFolder = await drive.files.create({
      requestBody: {
        name: "Filtered_Images",
        mimeType: "application/vnd.google-apps.folder",
        parents: [folderId],
      },
      fields: "id",
    });

    const newFolderId = newFolder.data.id;

    // Lấy danh sách file
    const files = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: "files(id, name)",
    });

    // Copy file match
    for (const file of files.data.files) {
      if (fileCodes.includes(file.name)) {
        await drive.files.copy({
          fileId: file.id,
          requestBody: { parents: [newFolderId] },
        });
      }
    }

    res.send(`https://drive.google.com/drive/folders/${newFolderId}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Có lỗi khi lọc ảnh!");
  }
});

app.listen(3000, () => console.log("Server chạy tại http://localhost:3000"));