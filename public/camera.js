let ws = null;
let stream = null;
let cameraId = null;
let frameCount = 0;

document.addEventListener('DOMContentLoaded', () => {
  startCamera();
});

async function startCamera() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name') || 'Камера';
  const token = params.get('token');

  document.getElementById('camTitle').textContent = decodeURIComponent(name).toUpperCase();

  try {
    // 640x480 при 20 FPS — оптимально для трансляции нескольких камер одновременно
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20 } },
      audio: false
    });

    const video = document.getElementById('videoPreview');
    video.srcObject = stream;
    await video.play();

    connectWS(name, token);
  } catch (e) {
    updateStatus('disconnected', 'Ошибка доступа к камере: ' + e.message);
  }
}

function connectWS(name, token) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${protocol}://${location.host}?role=camera&name=${encodeURIComponent(name)}`;
  if (token) url += `&token=${token}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    updateStatus('connected', '● Трансляция идет');
    startStreaming();
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'registered') cameraId = msg.id;
    } catch(err) {}
  };

  ws.onclose = () => {
    updateStatus('disconnected', '● Отключено. Переподключение...');
    setTimeout(() => connectWS(name, token), 2000);
  };
}

function startStreaming() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  const video = document.getElementById('videoPreview');
  const encoder = new TextEncoder();

  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !cameraId || ws.bufferedAmount > 0) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob || ws.bufferedAmount > 0) return;

      blob.arrayBuffer().then(jpegBuffer => {
        const idBytes = encoder.encode(cameraId);
        const packet = new Uint8Array(1 + idBytes.length + jpegBuffer.byteLength);

        packet[0] = idBytes.length;
        packet.set(idBytes, 1);
        packet.set(new Uint8Array(jpegBuffer), 1 + idBytes.length);

        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount === 0) {
          ws.send(packet.buffer);
          frameCount++;
          document.getElementById('frameCount').textContent = frameCount;
        }
      });
    }, 'image/jpeg', 0.4);

  }, 1000 / 20); // 20 FPS
}

function updateStatus(type, text) {
  const el = document.getElementById('status');
  el.className = `status-indicator status-${type}`;
  el.textContent = text;
}
