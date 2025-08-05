require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const db = require('./firebase');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const clients = new Map();

function createClient(clientId) {
  const sessionRef = db.ref(`sessions/${clientId}`);

  return new Promise(async (resolve, reject) => {
    const sessionData = await sessionRef.once('value').then(s => s.val());

    const client = new Client({
      puppeteer: { headless: true, args: ['--no-sandbox'] },
      session: sessionData || undefined,
    });

    client.on('qr', qr => {
      io.to(clientId).emit('qr', { deviceId: clientId, qr });
    });

    client.on('authenticated', session => {
      sessionRef.set(session);
    });

    client.on('ready', () => {
      io.to(clientId).emit('ready', { deviceId: clientId });
      console.log(`✅ Cliente ${clientId} conectado`);
    });

    client.on('auth_failure', () => {
      console.log(`❌ Falha de autenticação: ${clientId}`);
      io.to(clientId).emit('auth_failure', { deviceId: clientId });
      sessionRef.remove();
    });

    client.on('disconnected', () => {
      console.log(`⚠️ Cliente ${clientId} desconectado`);
      io.to(clientId).emit('disconnected', { deviceId: clientId });
      sessionRef.remove();
    });

    client.initialize();
    clients.set(clientId, client);
    resolve(client);
  });
}

io.on('connection', socket => {
  const clientId = socket.handshake.query.clientId;

  if (!clientId) {
    socket.disconnect();
    return;
  }

  socket.join(clientId);

  if (!clients.has(clientId)) {
    createClient(clientId).catch(err => {
      console.error(`Erro ao iniciar cliente ${clientId}:`, err);
      socket.emit('error', 'Erro ao iniciar cliente');
    });
  }

  socket.on('send-message', async ({ number, message }) => {
    const client = clients.get(clientId);
    if (!client) return socket.emit('error', 'Cliente não iniciado');

    try {
      const chatId = `${number}@c.us`;
      await client.sendMessage(chatId, message);
      socket.emit('message-sent', { number, message });
    } catch (err) {
      console.error('Erro ao enviar mensagem:', err);
      socket.emit('error', 'Erro ao enviar mensagem');
    }
  });
});

app.get('/', (req, res) => {
  res.send('Servidor WhatsApp Web está no ar.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado em http://localhost:${PORT}`);
});
