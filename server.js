const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = 8000;
const clients = new Map();
const peerConnections = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    const html = fs.readFileSync('./chat.html', 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket' || 
      !req.headers['connection']?.toLowerCase().includes('upgrade')) {
    socket.end('HTTP/1.1 400 Bad Request');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request');
    return;
  }

  const accept = generateAcceptValue(key);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];

  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
  
  const clientId = crypto.randomBytes(16).toString('hex');
  clients.set(clientId, {
    socket,
    username: `User${clients.size + 1}`,
    clientId,
    lastTypingTime: 0
  });
  // tell this socket its own ID
  sendMessage(socket, {
    type: 'init',
    clientId,
    username: clients.get(clientId).username
  });

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let maskStart = 2;
      let dataStart = maskStart + 4;

      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        maskStart = 4;
        dataStart = 8;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        maskStart = 10;
        dataStart = 14;
      }
      
      const totalLength = dataStart + payloadLength;
      if (buffer.length < totalLength) return;

      if (opcode === 0x8) {
        socket.end();
        return;
      }
      
      if (opcode === 0x1) {
        const mask = buffer.slice(maskStart, dataStart);
        const encoded = buffer.slice(dataStart, totalLength);
        const decoded = Buffer.alloc(payloadLength);
        
        for (let i = 0; i < payloadLength; i++) {
          decoded[i] = encoded[i] ^ mask[i % 4];
        }
        
        const message = decoded.toString('utf8');
        handleClientMessage(clientId, message);
      }
      
      buffer = buffer.slice(totalLength);
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    clients.delete(clientId);
    peerConnections.delete(clientId);
  });

  socket.on('close', () => {
    broadcastUserLeft(clientId);
    clients.delete(clientId);
    peerConnections.delete(clientId);
  });
});

function handleClientMessage(clientId, rawMessage) {
  try {
    const message = JSON.parse(rawMessage);
    const clientData = clients.get(clientId);
    
    switch (message.type) {
      case 'message':
        broadcastMessage(clientId, {
          type: 'message',
          content: message.content,
          sender: clientData.username,
          timestamp: new Date().toISOString()
        });
        break;
        
      case 'typing':
        const now = Date.now();
        if (now - clientData.lastTypingTime > 500) {
          clientData.lastTypingTime = now;
          broadcastTyping(clientId, clientData.username);
        }
        break;
        
      case 'set_username':
        clientData.username = message.username || clientData.username;
        break;

      case 'offer':
      case 'answer':
      case 'candidate':
        forwardSignal(clientId, message);
        break;

      case 'call-request':
        handleCallRequest(clientId, message.target);
        break;
        // In handleClientMessage function
case 'get_client_id':
  sendMessage(clientData.socket, {
    type: 'client_id',
    id: clientId
  });
  break;
    }
  } catch (e) {
    console.error('Error parsing message:', e);
  }
}

function forwardSignal(senderId, signal) {
  const target = clients.get(signal.target);
    if (target && target.socket.writable) {
       console.log(`[SERVER] forwarding ${signal.type} from ${senderId} → ${signal.target}`);
       sendMessage(target.socket, {
         type: signal.type,
         sender: senderId,
         payload: signal.payload
       });
     } else {
       console.warn(`[SERVER] can’t forward ${signal.type}: target ${signal.target} missing or socket closed`);
      }
}

function handleCallRequest(senderId, targetId) {
  const target = clients.get(targetId);
  if (target) {
    sendMessage(target.socket, {
      type: 'call-request',
      sender: senderId
    });
  }
}

function broadcastMessage(senderId, message) {
  const payload = JSON.stringify(message);
  clients.forEach((clientData, clientId) => {
    if (clientId !== senderId && clientData.socket.writable) {
      clientData.socket.write(encodeMessage(payload));
    }
  });
}

function broadcastTyping(senderId, username) {
  const payload = JSON.stringify({
    type: 'typing',
    sender: username
  });
  
  clients.forEach((clientData, clientId) => {
    if (clientId !== senderId && clientData.socket.writable) {
      clientData.socket.write(encodeMessage(payload));
    }
  });
}

function broadcastUserLeft(clientId) {
  const clientData = clients.get(clientId);
  if (!clientData) return;
  
  const payload = JSON.stringify({
    type: 'user_left',
    username: clientData.username
  });
  
  clients.forEach((targetData, targetId) => {
    if (targetId !== clientId && targetData.socket.writable) {
      targetData.socket.write(encodeMessage(payload));
    }
  });
}

function sendMessage(socket, message) {
  if (socket.writable) {
    socket.write(encodeMessage(JSON.stringify(message)));
  }
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

function generateAcceptValue(key) {
  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');
}

function encodeMessage(str) {
  const msg = Buffer.from(str);
  const frame = [0x81];

  if (msg.length < 126) {
    frame.push(msg.length);
  } else if (msg.length < 65536) {
    frame.push(126, (msg.length >> 8) & 255, msg.length & 255);
  } else {
    const lenBytes = Buffer.alloc(8);
    lenBytes.writeBigUInt64BE(BigInt(msg.length));
    frame.push(127, ...lenBytes);
  }

  return Buffer.concat([Buffer.from(frame), msg]);
}