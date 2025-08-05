const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 🔐 Firebase Admin Init
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});
const bucket = admin.storage().bucket();

// 🌐 Express Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.json());

// 📁 Sessões em memória
const sessions = {};

// ⬇️ Baixar arquivos da sessão do Firebase
async function restaurarSessao(sessionId) {
  const files = [
    `whatsapp-sessions/${sessionId}/Default/session-0.json`,
    `whatsapp-sessions/${sessionId}/Default/session-1.json`,
    `whatsapp-sessions/${sessionId}/DevToolsActivePort`,
  ];

  for (const filePath of files) {
    const localPath = path.join(os.homedir(), `.wwebjs_auth`, sessionId, filePath.split('/').slice(2).join('/'));
    const fileDir = path.dirname(localPath);
    fs.mkdirSync(fileDir, { recursive: true });

    const remoteFile = bucket.file(filePath);
    const exists = (await remoteFile.exists())[0];

    if (exists) {
      await remoteFile.download({ destination: localPath });
      console.log(`📥 ${filePath} restaurado para ${localPath}`);
    } else {
      console.log(`⚠️ ${filePath} não encontrado no Firebase`);
    }
  }
}

// ⬆️ Enviar arquivos da sessão para o Firebase
async function salvarSessao(sessionId) {
  const basePath = path.join(os.homedir(), `.wwebjs_auth`, sessionId);
  const files = [
    `Default/session-0.json`,
    `Default/session-1.json`,
    `DevToolsActivePort`,
  ];

  for (const fileRelPath of files) {
    const localPath = path.join(basePath, fileRelPath);
    if (fs.existsSync(localPath)) {
      const remotePath = `whatsapp-sessions/${sessionId}/${fileRelPath}`;
      await bucket.upload(localPath, { destination: remotePath });
      console.log(`📁 Sessão ${sessionId}: arquivo ${fileRelPath} salvo no Firebase.`);
    } else {
      console.log(`❌ Sessão ${sessionId}: arquivo ${fileRelPath} não encontrado localmente.`);
    }
  }

  console.log(`✅ Sessão ${sessionId} salva no Firebase.`);
}

// 🚀 Inicializar nova sessão
async function iniciarSessao(sessionId, socket) {
  await restaurarSessao(sessionId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });

  sessions[sessionId] = client;

  client.on('qr', async qr => {
    const qrDataUrl = await QRCode.toDataURL(qr);
    socket.emit('qr', { sessionId, qr: qrDataUrl });
    console.log(`📲 QR Code gerado para sessão ${sessionId}`);
  });

  client.on('authenticated', () => {
    console.log(`🔐 Sessão ${sessionId} autenticada`);
  });

  client.on('ready', async () => {
    console.log(`✅ Sessão ${sessionId} pronta`);
    await salvarSessao(sessionId);
  });

  client.on('disconnected', reason => {
    console.log(`⚠️ Sessão ${sessionId} desconectada: ${reason}`);
    client.destroy();
    delete sessions[sessionId];
  });

  await client.initialize();
}

// 🔌 WebSocket: iniciar sessão
io.on('connection', socket => {
  console.log('📡 Cliente conectado');

  socket.on('iniciar-sessao', async sessionId => {
    if (sessions[sessionId]) {
      console.log(`ℹ️ Sessão ${sessionId} já está ativa.`);
      return;
    }
    try {
      await iniciarSessao(sessionId, socket);
    } catch (err) {
      console.error(`❌ Erro ao iniciar sessão ${sessionId}:`, err);
    }
  });
});

// 📤 Enviar mensagem
app.post('/enviar-whatsapp', async (req, res) => {
  const { numero, mensagem, sessionId } = req.body;
  if (!numero || !mensagem || !sessionId) {
    return res.status(400).send({ erro: 'Campos obrigatórios: numero, mensagem, sessionId' });
  }

  const client = sessions[sessionId];
  if (!client) {
    return res.status(404).send({ erro: `Sessão ${sessionId} não encontrada ou não conectada.` });
  }

  try {
    await client.sendMessage(`${numero}@c.us`, mensagem);
    res.send({ status: 'Mensagem enviada com sucesso!' });
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem:', err);
    res.status(500).send({ erro: 'Erro ao enviar mensagem' });
  }
});

// 🚀 Iniciar servidor
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
