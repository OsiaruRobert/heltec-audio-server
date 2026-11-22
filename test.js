// simulate_heltec.js - Simulates Heltec V3 button hold + audio stream
const sampleRate = 8000;
const durationSec = 10;
const totalSamples = sampleRate * durationSec;
const pcmBuffer = Buffer.alloc(totalSamples * 2);

// Generate a 440 Hz sine wave tone (simulating microphone input)
for (let i = 0; i < totalSamples; i++) {
  const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
  pcmBuffer.writeInt16LE(sample, i * 2);
}

const res = await fetch('http://localhost:3000/api/audio', {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: pcmBuffer
});

console.log('Server response:', await res.json());
