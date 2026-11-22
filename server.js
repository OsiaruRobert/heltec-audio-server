import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.resolve('./recordings');

// Ensure local storage folder exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Accept raw binary audio streams up to 5MB
app.use('/api/audio', express.raw({ type: 'application/octet-stream', limit: '5mb' }));

/**
 * Builds a standard 44-byte PCM WAV header
 */
function createWavHeader(dataLength, sampleRate = 8000, numChannels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);             // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);              // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);    // NumChannels (1 = Mono)
  header.writeUInt32LE(sampleRate, 24);     // SampleRate (8000 Hz)
  header.writeUInt32LE(byteRate, 28);       // ByteRate
  header.writeUInt16LE(blockAlign, 32);     // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);  // BitsPerSample (16-bit)
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

// ==========================================
// POST /api/audio - Save incoming Heltec PCM
// ==========================================
app.post('/api/audio', (req, res) => {
  const pcmBuffer = req.body;

  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
    return res.status(400).json({ error: 'Empty audio payload' });
  }

  const wavHeader = createWavHeader(pcmBuffer.length, 8000, 1, 16);
  const wavFileBuffer = Buffer.concat([wavHeader, pcmBuffer]);

  const id = String(Date.now());
  const filename = `audio_${id}.wav`;
  const filePath = path.join(RECORDINGS_DIR, filename);

  fs.writeFileSync(filePath, wavFileBuffer);

  const durationSec = (pcmBuffer.length / (8000 * 2)).toFixed(2);
  console.log(`Saved ${filename} (${durationSec}s, ${wavFileBuffer.length} bytes)`);

  res.status(200).json({
    status: 'saved',
    id,
    file: filename,
    durationSeconds: Number(durationSec)
  });
});

// ==========================================
// GET /list - List all saved recordings
// ==========================================
app.get('/list', (req, res) => {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR)
      .filter((file) => file.endsWith('.wav'))
      .map((file) => {
        const filePath = path.join(RECORDINGS_DIR, file);
        const stats = fs.statSync(filePath);
        const id = file.replace(/^audio_/, '').replace(/\.wav$/, '');
        const pcmBytes = Math.max(0, stats.size - 44);
        const durationSeconds = Number((pcmBytes / (8000 * 2)).toFixed(2));

        return {
          id,
          filename: file,
          sizeBytes: stats.size,
          durationSeconds,
          createdAt: stats.birthtime,
          url: `/list/${id}`
        };
      })
      .sort((a, b) => Number(b.id) - Number(a.id)); // Newest first

    res.status(200).json({
      count: files.length,
      recordings: files
    });
  } catch (err) {
    console.error('Error listing recordings:', err);
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

// ==========================================
// GET /list/:id - Stream/fetch a single WAV
// ==========================================
app.get('/list/:id', (req, res) => {
  // Sanitize ID to prevent directory traversal
  const rawId = path.basename(req.params.id).replace(/\.wav$/, '');
  const filename = rawId.startsWith('audio_') ? `${rawId}.wav` : `audio_${rawId}.wav`;
  const filePath = path.join(RECORDINGS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio recording not found' });
  }

  res.setHeader('Content-Type', 'audio/wav');
  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`Audio API listening on http://0.0.0.0:${PORT}/api/audio`);
  console.log(`List endpoint ready at  http://0.0.0.0:${PORT}/list`);
});
