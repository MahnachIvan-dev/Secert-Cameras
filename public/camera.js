let ws = null;
let stream = null;
let cameraId = null;
const peerConnections = {}; // viewerId -> RTCPeerConnection

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('autostart') === '1') {
    setTimeout(startCamera, 500);
  }
});

async function startCamera() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name') || 'Camera';
  const location = params.get('location') || 'Room';
  const token = params.get('token');

  try {
    // Захватываем полноценный видеопоток высокой четкости HD (30-60 FPS)
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    });

    const video = document.getElementById('videoPreview');
    video.srcObject = stream;
    await video.play();

    document.getElementById('settingsSection').style.display = 'none';
    document.getElementById('previewSection').style.display = 'block';

    connectWS(name, location, token);
  } catch (e) {
    alert('Ошибка доступа к камере: ' + e.message);
  }
}

function connectWS(name, location, token) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${protocol}://${location.host}?role=camera&name=${encodeURIComponent(name)}&location=${encodeURIComponent(location)}`;
  if (token) url += `&token=${token}`;

  ws = new WebSocket(url);

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'registered':
          cameraId = msg.id;
          break;

        case 'request-stream':
          createPeerConnection(msg.viewerId);
          break;

        case 'answer':
          if (peerConnections[msg.viewerId]) {
            await peerConnections[msg.viewerId].setRemoteDescription(new RTCSessionDescription(msg.sdp));
          }
          break;

        case 'candidate':
          if (peerConnections[msg.viewerId] && msg.candidate) {
            await peerConnections[msg.viewerId].addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
          break;
      }
    } catch (e) {}
  };
}

async function createPeerConnection(viewerId) {
  if (peerConnections[viewerId]) peerConnections[viewerId].close();

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[viewerId] = pc;

  // Добавляем треки трансляции камеры
  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: 'candidate',
        targetViewerId: viewerId,
        candidate: event.candidate
      }));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'offer',
    targetViewerId: viewerId,
    sdp: offer
  }));
}

window.startCamera = startCamera;
