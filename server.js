const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const cameras = new Map();
const viewers = new Map();
const cameraTokens = new Map();

// REST API
app.post('/api/generate-link', (req, res) => {
  const { name, location } = req.body;
  const token = uuidv4();
  cameraTokens.set(token, { name: name || 'Camera', location: location || 'Room' });

  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');
  const url = `${protocol}://${host}/camera.html?token=${token}&name=${encodeURIComponent(name || '')}&location=${encodeURIComponent(location || '')}&autostart=1`;

  res.json({ token, url });
});

app.get('/api/cameras', (req, res) => {
  const list = [];
  cameras.forEach(c => list.push({ id: c.id, name: c.name, location: c.location, status: c.status }));
  res.json(list);
});

// WEBSOCKET SIGNALING
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role');

  if (role === 'camera') {
    const token = url.searchParams.get('token');
    const id = token || uuidv4();
    const name = decodeURIComponent(url.searchParams.get('name') || 'Camera');
    const location = decodeURIComponent(url.searchParams.get('location') || 'Room');

    const cam = { id, name, location, status: 'online', ws };
    cameras.set(id, cam);

    ws.send(JSON.stringify({ type: 'registered', id }));
    broadcastToViewers({ type: 'camera-online', camera: { id, name, location, status: 'online' } });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Пересылаем сигналы WebRTC конкретному зрителю
        if (msg.targetViewerId) {
          viewers.forEach((v, vWs) => {
            if (v.id === msg.targetViewerId && vWs.readyState === 1) {
              vWs.send(JSON.stringify({ ...msg, cameraId: id }));
            }
          });
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      cameras.delete(id);
      broadcastToViewers({ type: 'camera-offline', cameraId: id });
    });

  } else {
    // Viewer
    const viewerId = uuidv4();
    viewers.set(ws, { id: viewerId });

    const camList = [];
    cameras.forEach(c => camList.push({ id: c.id, name: c.name, location: c.location, status: c.status }));
    ws.send(JSON.stringify({ type: 'camera-list', cameras: camList, viewerId }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Пересылаем сигналы WebRTC конкретной камере
        if (msg.cameraId && cameras.has(msg.cameraId)) {
          const cam = cameras.get(msg.cameraId);
          if (cam.ws && cam.ws.readyState === 1) {
            cam.ws.send(JSON.stringify({ ...msg, viewerId }));
          }
        }
      } catch (e) {}
    });

    ws.on('close', () => viewers.delete(ws));
  }
});

function broadcastToViewers(msg) {
  const data = JSON.stringify(msg);
  viewers.forEach((_, ws) => { if (ws.readyState === 1) ws.send(data); });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎥 WebRTC Server running on port ${PORT}`);
});
