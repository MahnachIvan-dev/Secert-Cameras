const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const cameras = new Map();
const viewers = new Map();
const cameraTokens = new Map();

// Генерация уникальной ссылки для новой камеры
app.post('/api/generate-link', (req, res) => {
  const { name, location } = req.body;
  const token = uuidv4();
  cameraTokens.set(token, { name: name || 'Камера', location: location || 'Помещение' });

  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');
  const url = `${protocol}://${host}/camera.html?token=${token}&name=${encodeURIComponent(name || '')}&location=${encodeURIComponent(location || '')}&autostart=1`;

  res.json({ token, url });
});

// Список активных камер
app.get('/api/cameras', (req, res) => {
  const list = [];
  cameras.forEach(c => list.push({ id: c.id, name: c.name, location: c.location, status: c.status }));
  res.json(list);
});

// Удаление камеры
app.delete('/api/cameras/:id', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (cam) {
    if (cam.ws && cam.ws.readyState === 1) cam.ws.close();
    cameras.delete(req.params.id);
    broadcastToViewers({ type: 'camera-removed', cameraId: req.params.id });
  }
  res.json({ success: true });
});

// WebSocket обработка
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role');

  if (role === 'camera') {
    const token = url.searchParams.get('token');
    const id = token || uuidv4();
    const name = decodeURIComponent(url.searchParams.get('name') || `Камера-${id.slice(0, 4)}`);
    const location = decodeURIComponent(url.searchParams.get('location') || 'Общий обзор');

    const cam = { id, name, location, status: 'online', ws };
    cameras.set(id, cam);

    console.log(`📷 Камера подключена: ${name} (ID: ${id})`);
    ws.send(JSON.stringify({ type: 'registered', id }));
    broadcastToViewers({ type: 'camera-online', camera: { id, name, location, status: 'online' } });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Пересылаем бинарный видеокадр подписчикам этой конкретной камеры
        viewers.forEach((v, vWs) => {
          if (v.subscribed.has(id) && vWs.readyState === 1 && vWs.bufferedAmount === 0) {
            vWs.send(data, { binary: true });
          }
        });
      }
    });

    ws.on('close', () => {
      cameras.delete(id);
      console.log(`❌ Камера отключена: ${name}`);
      broadcastToViewers({ type: 'camera-offline', cameraId: id });
    });

  } else {
    // Зритель (Главная панель)
    const viewerId = uuidv4();
    const viewerInfo = { id: viewerId, subscribed: new Set() };
    viewers.set(ws, viewerInfo);

    const camList = [];
    cameras.forEach(c => camList.push({ id: c.id, name: c.name, location: c.location, status: c.status }));
    ws.send(JSON.stringify({ type: 'camera-list', cameras: camList }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe-all') {
          cameras.forEach((_, id) => viewerInfo.subscribed.add(id));
        } else if (msg.type === 'subscribe') {
          viewerInfo.subscribed.add(msg.cameraId);
        } else if (msg.type === 'unsubscribe') {
          viewerInfo.subscribed.delete(msg.cameraId);
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
server.listen(PORT, '0.0.0.0', () => console.log(`🎥 Server listening on port ${PORT}`));
