require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const app = express();
const port = process.env.PORT || 3000;

// 1. Konfigurasi AWS S3 Client (v3)
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 2. Middleware
app.use(cors()); // Allow all origin (bisa diperketat nanti)
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, "../uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Gunakan variable UPLOAD_DIR yang sudah kita set path-nya
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});
// Konfigurasi Multer (Simpan di RAM sementara sebelum ke S3)
// Note: Untuk file > 500MB, disarankan pakai Presigned URL (lihat catatan di bawah)
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 500 * 1024 * 1024 }, // Limit 500MB
// });

const upload = multer({ storage: storage });

const uploadToS3 = async (filePath, originalName) => {
  const fileStream = fs.createReadStream(filePath);
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: originalName,
    Body: fileStream,
  });
  await s3Client.send(command);
};

const cleanupFiles = (files) => {
  files.forEach((file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
};
// ==========================================
// ROUTES
// ==========================================

// 1. Upload PMTiles Langsung (Tanpa Convert)
app.post("/upload-pmtiles", upload.single("mapFile"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const fileName = req.file.originalname;

    await uploadToS3(filePath, fileName);

    // Hapus file temp setelah upload sukses
    cleanupFiles([filePath]);

    res.json({ success: true, message: "PMTiles uploaded successfully" });
  } catch (error) {
    cleanupFiles([req.file?.path]); // Hapus jika error
    res.status(500).json({ error: error.message });
  }
});

app.post("/upload-geojson", upload.single("geoJsonFile"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const inputPath = req.file.path;
  // Tentukan nama output (ganti ekstensi .json/.geojson jadi .pmtiles)
  const outputFileName =
    req.file.originalname.replace(/\.(json|geojson)$/i, "") + ".pmtiles";
  const outputPath = path.join(UPLOAD_DIR, `converted-${Date.now()}.pmtiles`);

  console.log(`🔄 Converting ${req.file.originalname} to PMTiles...`);

  // Command Tippecanoe
  // -zg: Zoom guess (otomatis)
  // --drop-densest-as-needed: Agar tidak error jika data terlalu padat
  // -f: Force overwrite output
  const cmd = `tippecanoe -o ${outputPath} -zg --drop-densest-as-needed --force ${inputPath}`;

  // Jalankan perintah terminal
  exec(cmd, async (error, stdout, stderr) => {
    if (error) {
      console.error(`Exec error: ${error}`);
      cleanupFiles([inputPath, outputPath]); // Bersih-bersih
      return res
        .status(500)
        .json({ error: "Conversion failed", details: stderr });
    }

    try {
      console.log("✅ Conversion done. Uploading to S3...");

      // Upload hasil convert ke S3
      await uploadToS3(outputPath, outputFileName);

      // Bersih-bersih file temp
      cleanupFiles([inputPath, outputPath]);

      res.json({
        success: true,
        message: "GeoJSON converted and uploaded successfully!",
        s3_key: outputFileName,
      });
    } catch (uploadError) {
      console.error(uploadError);
      cleanupFiles([inputPath, outputPath]);
      res.status(500).json({ error: "S3 Upload failed after conversion" });
    }
  });
});
// 📌 READ: List semua file PMTiles di Bucket
app.get("/maps", async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.AWS_BUCKET_NAME,
    });

    const response = await s3Client.send(command);

    // Filter hanya file .pmtiles dan format outputnya
    const maps = (response.Contents || [])
      .filter((item) => item.Key.endsWith(".pmtiles"))
      .map((item) => ({
        filename: item.Key,
        url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`,
        size: item.Size,
        lastModified: item.LastModified,
      }));

    res.json({ success: true, data: maps });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 CREATE: Upload file PMTiles
app.post("/upload", upload.single("mapFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Validasi ekstensi sederhana
    if (!req.file.originalname.endsWith(".pmtiles")) {
      return res.status(400).json({ error: "Only .pmtiles files are allowed" });
    }

    const fileName = req.file.originalname; // Bisa diganti unique ID jika perlu

    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: "application/octet-stream",
    });

    await s3Client.send(command);

    res.json({
      success: true,
      message: "File uploaded successfully",
      url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 DELETE: Hapus file PMTiles
app.delete("/maps/:filename", async (req, res) => {
  try {
    const { filename } = req.params;

    const command = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: filename,
    });

    await s3Client.send(command);

    res.json({
      success: true,
      message: `File ${filename} deleted successfully`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
