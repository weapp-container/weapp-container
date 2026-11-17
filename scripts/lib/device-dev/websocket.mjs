import { createHash } from 'node:crypto';

const LIMIT = 65536;
export function acceptWebSocket(request, socket, head, { message, close }) {
  const key = request.headers['sec-websocket-key'];
  if (request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null;
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let pending = Buffer.alloc(0), fragments = [], fragmentBytes = 0, fragmented = false, ended = false;
  function frame(op, body) {
    if (ended || socket.destroyed) return;
    if (socket.writableLength + body.length > 1024 * 1024) { socket.destroy(); return; }
    const h = body.length < 126 ? Buffer.from([0x80 | op, body.length]) : Buffer.from([0x80 | op, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([h, body]));
  }
  const stop = (code = 1000) => { if (!ended) { frame(8, Buffer.from([code >> 8, code & 255])); ended = true; socket.end(); } };
  const read = bytes => {
    pending = Buffer.concat([pending, bytes]);
    if (pending.length > 2 * LIMIT) { stop(1009); return; }
    while (!ended && pending.length >= 2) {
      const first = pending[0], op = first & 15, final = !!(first & 128), masked = !!(pending[1] & 128);
      let size = pending[1] & 127, pos = 2;
      if ((first & 112) || !masked || size === 127) { stop(1002); return; }
      if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); pos = 4; if (size < 126) { stop(1002); return; } }
      if ((op >= 8 && (!final || size > 125)) || size + fragmentBytes > LIMIT) { stop(1009); return; }
      if (pending.length < pos + 4 + size) return;
      const mask = pending.subarray(pos, pos + 4), body = Buffer.from(pending.subarray(pos + 4, pos + 4 + size));
      pending = pending.subarray(pos + 4 + size);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      if (op === 8) { stop(); return; }
      if (op === 9) { frame(10, body); continue; }
      if (op === 10) continue;
      if ((op !== 0 && op !== 1) || (op === 0 && !fragmented) || (op === 1 && fragmented)) { stop(1002); return; }
      fragments.push(body); fragmentBytes += size; fragmented = !final;
      if (!final) continue;
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments)));
        fragments = []; fragmentBytes = 0; message(value);
      } catch { stop(1007); }
    }
  };
  socket.on('data', read); socket.on('error', () => {});
  socket.once('close', () => { ended = true; close(); });
  if (head.length) read(head);
  return { send(value) { const body = Buffer.from(JSON.stringify(value)); if (body.length >= LIMIT) return false; frame(1, body); return !ended; }, close: stop };
}
