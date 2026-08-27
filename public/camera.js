function startSending() {
  const fps = parseInt(document.getElementById('fpsRange').value) || 10;
  const quality = parseInt(document.getElementById('qualityRange').value) / 100 || 0.4;
  const interval = 1000 / fps;

  log(`Отправка: ${fps} fps, качество: ${Math.round(quality * 100)}%`, 'info');

  if (sendInterval) clearInterval(sendInterval);

  sendInterval = setInterval(() => {
    // 1. Проверяем готово ли соединение
    if (!ws || ws.readyState !== WebSocket.OPEN || !video || video.paused) return;

    // 2. КРИТИЧЕСКИ ВАЖНО: Если буфер отправки не пуст (сеть не успевает) — ПРОПУСКАЕМ кадр!
    // Это уберёт накопление задержки (лага).
    if (ws.bufferedAmount > 0) {
      return; 
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (motionEnabled) detectMotion();

    // 3. Отправляем как бинарный Blob (быстрее и легче чем Base64 string)
    canvas.toBlob((blob) => {
      if (blob && ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount === 0) {
        ws.send(blob);
        frameCount++;
        document.getElementById('frameCount').textContent = frameCount;
      }
    }, 'image/jpeg', quality);

  }, interval);
}
