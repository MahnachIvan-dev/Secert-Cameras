let ws = null;
let stream = null;
let cameraId = null;

document.addEventListener('DOMContentLoaded', () => {
  startCamera();
});

async function startCamera() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name') || 'Camera';
  const token = params.get('token');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20 } },
      audio: false
    });

    const video = document.getElementById('videoPreview');
    video.srcObject = stream;
    await video.play();

    connectWS(name, token);
  } catch (e) {
    document.getElementById('status').textContent = 'Ошибка доступа к камере: ' + e.message;
  }
}

function connectWS(name, token) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${protocol}://${location.host}?role=camera&name=${encodeURIComponent(name)}`;
  if (token) url += `&token=${token}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById('status').textContent = '● Трансляция идет';
    document.getElementById('status').style.color = 'var(--success)';
    startStreaming();
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'registered') cameraId = msg.id;
    } catch(err) {}
  };

  ws.onclose = () => {
    document.getElementById('status').textContent = 'Отключено. Переподключение...';
    document.getElementById('status').style.color = 'var(--danger)';
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
        }
      });
    }, 'image/jpeg', 0.4); // Качество 40% — баланс идеальной плавности и четкости

  }, 1000 / 20); // 20 FPS
}
