import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.resolve('./recordings');
const MAX_KEEP = 50; // Render's disk is small + ephemeral, so prune old files
const startedAt = Date.now();

const state = {
  uploads: 0,
  rejects: 0,
  lastUpload: null,
  lastDevice: null,
};

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ---------- Request logger (shows up in Render logs) ----------
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ` +
        `(${Date.now() - t}ms) ip=${req.headers['x-forwarded-for'] || req.ip} ` +
        `len=${req.headers['content-length'] || 0}`
    );
  });
  next();
});

// Accept raw audio regardless of content-type
app.use('/api/audio', express.raw({ type: () => true, limit: '5mb' }));

// ---------- Helpers ----------
function createWavHeader(dataLength, sampleRate = 8000, numChannels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// Peak + RMS of 16-bit LE PCM
function analyze(pcm) {
  let peak = 0;
  let sumSq = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return { peak, rms: n ? Math.round(Math.sqrt(sumSq / n)) : 0 };
}

function pruneOldFiles() {
  const files = fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.wav')).sort();
  while (files.length > MAX_KEEP) {
    const f = files.shift();
    fs.unlinkSync(path.join(RECORDINGS_DIR, f));
    console.log(`Pruned ${f}`);
  }
}

function resolveFile(rawParam) {
  const rawId = path.basename(rawParam).replace(/\.wav$/, '');
  const filename = rawId.startsWith('audio_') ? `${rawId}.wav` : `audio_${rawId}.wav`;
  return { filename, filePath: path.join(RECORDINGS_DIR, filename) };
}

// ---------- Health / status ----------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    recordingsOnDisk: fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.wav')).length,
    uploads: state.uploads,
    rejected: state.rejects,
    lastUpload: state.lastUpload,
    lastDevice: state.lastDevice,
  });
});

// ---------- POST /api/audio ----------
app.post('/api/audio', (req, res) => {
  let pcm = req.body;

  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    state.rejects++;
    console.warn(`Rejected empty payload (content-type: ${req.headers['content-type']})`);
    return res.status(400).json({ error: 'Empty audio payload' });
  }

  if (pcm.length % 2 !== 0) pcm = pcm.subarray(0, pcm.length - 1);

  const rateHeader = parseInt(req.get('x-sample-rate'), 10);
  const sampleRate = Number.isFinite(rateHeader) ? Math.min(48000, Math.max(2000, rateHeader)) : 8000;

  const { peak, rms } = analyze(pcm);
  const id = String(Date.now());
  const filename = `audio_${id}.wav`;
  const wav = Buffer.concat([createWavHeader(pcm.length, sampleRate, 1, 16), pcm]);
  fs.writeFileSync(path.join(RECORDINGS_DIR, filename), wav);
  pruneOldFiles();

  const durationSeconds = Number((pcm.length / (sampleRate * 2)).toFixed(2));

  state.uploads++;
  state.lastUpload = new Date().toISOString();
  state.lastDevice = {
    rssi: req.get('x-rssi') || null,
    freeHeap: req.get('x-heap') || null,
    devicePeak: req.get('x-peak') || null,
    sampleRate,
  };

  console.log(
    `Saved ${filename} | ${durationSeconds}s @ ${sampleRate}Hz | peak=${peak} rms=${rms} | ` +
      `rssi=${state.lastDevice.rssi} heap=${state.lastDevice.freeHeap}` +
      (peak < 200 ? ' | WARNING: near-silent (check mic wiring)' : '')
  );

  res.status(200).json({ status: 'saved', id, file: filename, durationSeconds, sampleRate, peak, rms });
});

// ---------- GET /list ----------
app.get('/list', (req, res) => {
  try {
    const files = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith('.wav'))
      .map((file) => {
        const filePath = path.join(RECORDINGS_DIR, file);
        const buf = fs.readFileSync(filePath);
        const id = file.replace(/^audio_/, '').replace(/\.wav$/, '');
        const sampleRate = buf.length >= 44 ? buf.readUInt32LE(24) : 8000;
        const pcm = buf.subarray(44);
        const { peak, rms } = analyze(pcm);
        return {
          id,
          filename: file,
          sizeBytes: buf.length,
          sampleRate,
          durationSeconds: Number((pcm.length / (sampleRate * 2)).toFixed(2)),
          peak,
          rms,
          silent: peak < 200,
          createdAt: new Date(Number(id)).toISOString(),
          url: `/list/${id}`,
        };
      })
      .sort((a, b) => Number(b.id) - Number(a.id));

    res.status(200).json({ count: files.length, recordings: files });
  } catch (err) {
    console.error('Error listing recordings:', err);
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

// ---------- GET /list/:id ----------
app.get('/list/:id', (req, res) => {
  const { filePath } = resolveFile(req.params.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Audio recording not found' });
  res.setHeader('Content-Type', 'audio/wav');
  res.sendFile(filePath);
});

// ---------- DELETE /list/:id ----------
app.delete('/list/:id', (req, res) => {
  const { filePath } = resolveFile(req.params.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ status: 'deleted' });
});

// ---------- Dashboard ----------
const DASHBOARD = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Heltec Audio Monitor</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px;max-width:760px;margin:auto}
  h1{font-size:1.2rem} .card{background:#181b22;border-radius:10px;padding:12px;margin:10px 0}
  .row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:.85rem;color:#9aa4b2}
  .bar{height:8px;background:#2a2f3a;border-radius:4px;margin:8px 0;overflow:hidden}
  .bar>div{height:100%;background:#4ade80} .warn{color:#fbbf24} audio{width:100%}
  .ok{color:#4ade80} .bad{color:#f87171} button{background:#2a2f3a;color:#e6e6e6;border:0;border-radius:6px;padding:4px 10px}
</style></head><body>
<h1>Heltec Audio Monitor</h1>
<div class="card" id="status">Loading...</div>
<div id="list"></div>
<script>
function ago(iso){ if(!iso) return 'never'; var s=Math.round((Date.now()-new Date(iso))/1000);
  if(s<60) return s+'s ago'; if(s<3600) return Math.round(s/60)+'m ago'; return Math.round(s/3600)+'h ago'; }
async function refresh(){
  try{
    var h = await (await fetch('/health')).json();
    document.getElementById('status').innerHTML =
      '<span class="ok">Server online</span> &middot; uptime '+h.uptimeSeconds+'s &middot; uploads '+h.uploads+
      ' &middot; rejected '+h.rejected+'<div class="row"><span>Last upload: '+ago(h.lastUpload)+'</span>'+
      '<span>RSSI: '+(h.lastDevice?h.lastDevice.rssi:'-')+' dBm</span>'+
      '<span>Device heap: '+(h.lastDevice?h.lastDevice.freeHeap:'-')+'</span></div>';
    var l = await (await fetch('/list')).json();
    var html = '';
    l.recordings.forEach(function(r){
      var pct = Math.min(100, Math.round(r.peak/32767*100));
      html += '<div class="card"><div class="row"><b>'+new Date(r.createdAt).toLocaleString()+'</b>'+
        '<span>'+r.durationSeconds+'s @ '+r.sampleRate+'Hz</span></div>'+
        '<div class="bar"><div style="width:'+pct+'%"></div></div>'+
        '<div class="row"><span>peak '+r.peak+' &middot; rms '+r.rms+'</span>'+
        (r.silent?'<span class="warn">near-silent: check mic wiring</span>':'<span class="ok">signal ok</span>')+
        '<button onclick="del(\\''+r.id+'\\')">delete</button></div>'+
        '<audio controls preload="none" src="'+r.url+'"></audio></div>';
    });
    document.getElementById('list').innerHTML = html || '<div class="card">No recordings yet.</div>';
  }catch(e){
    document.getElementById('status').innerHTML='<span class="bad">Cannot reach server</span>';
  }
}
async function del(id){ await fetch('/list/'+id,{method:'DELETE'}); refresh(); }
refresh(); setInterval(refresh, 5000);
</script></body></html>`;

app.get('/', (req, res) => res.type('html').send(DASHBOARD));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Audio API listening on port ${PORT}`);
  console.log(`POST /api/audio | GET /list | GET /health | dashboard at /`);
});