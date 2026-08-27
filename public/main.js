let ws = null;
let cameras = {};
let viewerId = null;
const peerConnections = {}; // cameraId -> RTCPeerConnection

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
});

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}?role=viewer`);

  ws.onopen = () => console.log('Connected to Signaling Server');

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'camera-list':
          viewerId = msg.viewerId;
          cameras = {};
          msg.cameras.forEach(c => cameras[c.id] = c);
          renderCameraList();
          renderGrid();
          // Запрашиваем WebRTC трансляцию у всех камер
          Object.keys(cameras).forEach(id => startWebRTC(id));
          break;

        case 'camera-online':
          cameras[msg.camera.id] = msg.camera;
          renderCameraList();
          renderGrid();
          startWebRTC(msg.camera.id);
          break;

        case 'camera-offline':
          if (cameras[msg.cameraId]) {
            cameras[msg.cameraId].status = 'offline';
            closePeerConnection(msg.cameraId);
            renderCameraList();
            renderGrid();
          }
          break;

        case 'offer':
          handleOffer(msg.cameraId, msg.sdp);
          break;

        case 'candidate':
          handleCandidate(msg.cameraId, msg.candidate);
          break;
      }
    } catch (e) {}
  };

  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

function startWebRTC(cameraId) {
  closePeerConnection(cameraId);

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[cameraId] = pc;

  pc.ontrack = (event) => {
    const video = document.getElementById(`video-${cameraId}`);
    const ph = document.getElementById(`ph-${cameraId}`);
    if (video) {
      video.srcObject = event.streams[0];
      video.style.display = 'block';
      if (ph) ph.style.display = 'none';
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: 'candidate',
        cameraId,
        candidate: event.candidate
      }));
    }
  };

  // Запрашиваем Offer у камеры
  ws.send(JSON.stringify({ type: 'request-stream', cameraId }));
}

async function handleOffer(cameraId, sdp) {
  const pc = peerConnections[cameraId];
  if (!pc) return;

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(JSON.stringify({
    type: 'answer',
    cameraId,
    sdp: answer
  }));
}

async function handleCandidate(cameraId, candidate) {
  const pc = peerConnections[cameraId];
  if (pc && candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function closePeerConnection(cameraId) {
  if (peerConnections[cameraId]) {
    peerConnections[cameraId].close();
    delete peerConnections[cameraId];
  }
}

function renderCameraList() {
  const list = document.getElementById('cameraList');
  const cams = Object.values(cameras);
  if (cams.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>Нет камер</p></div>`;
    return;
  }
  list.innerHTML = cams.map(c => `
    <div class="camera-item">
      <div class="cam-status" style="background:${c.status === 'online' ? 'var(--success)' : 'var(--danger)'}"></div>
      <div class="cam-info"><div class="cam-name">${c.name}</div></div>
    </div>
  `).join('');
}

function renderGrid() {
  const grid = document.getElementById('viewGrid');
  const cams = Object.values(cameras);

  if (cams.length === 0) {
    grid.innerHTML = `<div class="empty-state"><h3>Нет камер</h3><button class="btn btn-primary" onclick="openGenerateLink()">Подключить камеру</button></div>`;
    return;
  }

  grid.innerHTML = cams.map(cam => `
    <div class="video-cell">
      <div class="video-cell-header">
        <div class="video-cell-name">${cam.name}</div>
        <span class="badge badge-live">LIVE WebRTC</span>
      </div>
      <div class="video-cell-body">
        <video id="video-${cam.id}" autoplay playsinline muted style="width:100%; height:100%; object-fit:contain; display:none;"></video>
        <div class="video-placeholder" id="ph-${cam.id}">
          <div class="ph-icon">📷</div>
          <span>Подключение P2P...</span>
        </div>
      </div>
    </div>
  `).join('');
}

function openGenerateLink() {
  document.getElementById('linkModal').classList.add('open');
}

function closeLinkModal() {
  document.getElementById('linkModal').classList.remove('open');
}

async function generateLink() {
  const name = document.getElementById('linkName').value.trim() || 'Camera';
  const location = document.getElementById('linkLocation').value.trim() || 'Room';
  const resp = await fetch('/api/generate-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, location })
  });
  const data = await resp.json();
  document.getElementById('linkResult').value = data.url;
  document.getElementById('linkStep1').style.display = 'none';
  document.getElementById('linkStep2').style.display = 'block';
}

function copyLink() {
  const input = document.getElementById('linkResult');
  input.select();
  navigator.clipboard.writeText(input.value);
}
