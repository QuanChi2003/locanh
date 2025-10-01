import { google } from "googleapis";
import { getTokens } from "./oauth2callback.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const { folderId, fileCodes } = req.body;
    const auth = new google.auth.OAuth2(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      `${process.env.BASE_URL}/api/oauth2callback`
    );

    auth.setCredentials(getTokens());
    const drive = google.drive({ version: "v3", auth });

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

    // Quét file trong folder
    const files = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: "files(id, name)",
    });

    for (const file of files.data.files) {
      if (fileCodes.includes(file.name)) {
        await drive.files.copy({
          fileId: file.id,
          requestBody: { parents: [newFolderId] },
        });
      }
    }

    res.status(200).send(`https://drive.google.com/drive/folders/${newFolderId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Lỗi khi lọc ảnh!");
  }
}
