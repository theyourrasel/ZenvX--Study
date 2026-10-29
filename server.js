require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);

// Real-Time Socket.io Server (Messenger Chat + Audio/Video WebRTC Signaling)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e7 // 50MB max payload for chat media
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Temporary upload directory for large PDFs, Docs, and high-res images
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB file limit
});

// Initialize Google Gemini AI
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

/************************************************************************
 * 1. ZenvXai AUTO-PROMPT ENGINEERING & LARGE FILE / CAMERA SCANNER API
 ************************************************************************/
const ZENVX_STYD_SYSTEM_PROMPT = `
You are "ZenvXai", the official AI Academic Professor inside the "ZenvX Stydy" super app.
Whenever a student sends a messy question, a scanned math/physics photo from the calculator, or a large document, always organize your answer into this clean structure:

1. **মূল ধারণা (Core Concept):** Clear academic summary.
2. **প্রয়োজনীয় সূত্র ও LaTeX সমীকরণ (Formulas):** Use clean LaTeX ($...$ or $$...$$) for all equations.
3. **ধাপে ধাপে সমাধান (Step-by-Step Solution):** Complete derivation or numerical calculation with SI units.
4. **ক্যালকুলেটর ও শর্টকাট টিপস (991EX / Exam Tip):** Show how to verify the answer quickly on the ZenvX 991EX calculator.
`;

app.post('/api/zenvxai/ask', upload.single('file'), async (req, res) => {
  try {
    const { prompt, imageBase64 } = req.body;
    const uploadedFile = req.file;

    if (!ai) {
      return res.status(400).json({
        success: false,
        error: "সার্ভারে GEMINI_API_KEY কনফিগার করা নেই। .env ফাইল চেক করুন।"
      });
    }

    const contents = [];

    // Handle Camera Snapshot (from ZenvXai or Calculator SCAN button)
    if (imageBase64) {
      const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
      contents.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: cleanBase64
        }
      });
    }

    // Handle Large Uploaded File (PDF / Image / Doc / TXT)
    if (uploadedFile) {
      const fileBuffer = fs.readFileSync(uploadedFile.path);
      contents.push({
        inlineData: {
          mimeType: uploadedFile.mimetype,
          data: fileBuffer.toString("base64")
        }
      });
      fs.unlinkSync(uploadedFile.path); // Remove temp file after processing
    }

    contents.push(
      prompt || "এই ছবি বা ফাইলটির গাণিতিক ও বৈজ্ঞানিক সমাধান ধাপে ধাপে LaTeX সূত্রসহ করে দাও।"
    );

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: contents,
      config: {
        systemInstruction: ZENVX_STYD_SYSTEM_PROMPT,
        temperature: 0.25
      }
    });

    res.json({
      success: true,
      reply: response.text
    });

  } catch (error) {
    console.error("ZenvXai Error:", error);
    res.status(500).json({
      success: false,
      error: "ZenvXai সার্ভার রেসপন্স দিতে ব্যর্থ হয়েছে।",
      details: error.message
    });
  }
});

/************************************************************************
 * 2. CALCULATOR OCR PHOTO SCANNER ENDPOINT (Direct LaTeX Extraction)
 ************************************************************************/
app.post('/api/calculator/scan', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!ai || !imageBase64) {
      return res.status(400).json({ success: false, error: "Image or API Key missing" });
    }

    const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { inlineData: { mimeType: "image/jpeg", data: cleanBase64 } },
        "Extract the mathematical expression from this image and return a JSON object with keys: 'expr' (calculator evaluable string like '1/(pi^2)'), 'latex' (LaTeX string), and 'solution' (final numeric answer)."
      ]
    });

    res.json({ success: true, data: response.text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/************************************************************************
 * 3. EDUTUBE API PROXY (YouTube Videos & Vertical Shorts)
 ************************************************************************/
app.get('/api/edutube/feed', async (req, res) => {
  try {
    const query = req.query.q || 'HSC Physics Calculus Lecture Bangla';
    const isShorts = req.query.shorts === 'true';
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return res.json({ success: false, message: "No YouTube API key configured; using default stream." });
    }

    const durationParam = isShorts ? '&videoDuration=short' : '';
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${encodeURIComponent(query)}&type=video&safeSearch=strict${durationParam}&key=${apiKey}`;

    const ytRes = await fetch(url);
    const data = await ytRes.json();
    res.json({ success: true, items: data.items || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/************************************************************************
 * 4. SOCKET.IO MESSENGER & WEBRTC AUDIO/VIDEO CALL SIGNALING
 ************************************************************************/
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Connected to ZenvX Stydy: ${socket.id}`);

  socket.on('register-user', (user) => {
    activeUsers.set(socket.id, {
      socketId: socket.id,
      name: user.name || 'Student',
      role: user.role || 'student',
      avatar: user.avatar || ''
    });
    io.emit('online-users', Array.from(activeUsers.values()));
  });

  // Real-time Messenger Text & Formula Sharing
  socket.on('send-message', (payload) => {
    const msg = {
      id: Date.now(),
      senderId: socket.id,
      senderName: payload.senderName || 'Student',
      senderAvatar: payload.senderAvatar || '',
      text: payload.text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    io.emit('receive-message', msg);
  });

  // WebRTC Audio & Video Call Signaling
  socket.on('call-user', (data) => {
    socket.broadcast.emit('incoming-call', {
      from: socket.id,
      callerName: data.callerName,
      callerAvatar: data.callerAvatar,
      callType: data.callType, // 'audio' or 'video'
      offer: data.offer
    });
  });

  socket.on('answer-call', (data) => {
    io.to(data.to).emit('call-answered', {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.broadcast.emit('ice-candidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });

  socket.on('end-call', () => {
    socket.broadcast.emit('call-ended');
  });

  socket.on('disconnect', () => {
    activeUsers.delete(socket.id);
    io.emit('online-users', Array.from(activeUsers.values()));
  });
});

// Fallback route to serve the Single-Page App
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ZenvX Stydy Full-Stack Server running at http://localhost:${PORT}`);
});