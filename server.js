const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// =============== CONFIG FIREBASE ADMIN ===============
const serviceAccount = require('./pedagogia-systematrix-firebase-adminsdk-fbsvc-c6c428fcb2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix.firebaseio.com'
});
const db = admin.database();

const FIREBASE_DB_URL = 'https://pedagogia-systematrix-default-rtdb.firebaseio.com'; // sem / no final

// =============== CONFIG EXPRESS E SOCKET.IO ===============
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// =============== GERENCIAMENTO DE CLIENTES ===============
const clients = new Map(); // Map<deviceId, Client>
const activeSockets = new Map(); // Map<deviceId, socketId>

async function saveSessionToFirebase(schoolId) {
    try {
        const sessionPath = path.join(__dirname, 'sessions', `${schoolId}.json`);
        if (fs.existsSync(sessionPath)) {
            const sessionData = await fs.readFile(sessionPath, 'utf8');
            await axios.put(`${FIREBASE_DB_URL}/whatsapp-sessions/${schoolId}`, {
                data: Buffer.from(sessionData).toString('base64')
            });
            console.log(`[✅] Sessão de ${schoolId} salva no Firebase`);
        }
    } catch (err) {
        console.error('[❌] Erro ao salvar sessão no Firebase:', err.message);
    }
}

async function loadSessionFromFirebase(schoolId) {
    try {
        const res = await axios.get(`${FIREBASE_DB_URL}/whatsapp-sessions/${schoolId}`);
        if (res.data && res.data.data) {
            const sessionData = Buffer.from(res.data.data, 'base64').toString('utf8');
            const sessionPath = path.join(__dirname, 'sessions');
            await fs.ensureDir(sessionPath);
            await fs.writeFile(path.join(sessionPath, `${schoolId}.json`), sessionData, 'utf8');
            console.log(`[📥] Sessão de ${schoolId} restaurada do Firebase`);
        }
    } catch (err) {
        console.warn(`[⚠️] Sessão de ${schoolId} não encontrada no Firebase`);
    }
}

// Criar cliente WhatsApp com persistência de sessão
async function createClient(schoolId, socket) {
    await loadSessionFromFirebase(schoolId); // antes de criar o cliente

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './sessions',
            clientId: schoolId
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox']
        }
    });
    console.log('Sessão criada!')

    client.on('ready', async () => {
        console.log(`[✅] WhatsApp pronto para ${schoolId}`);
        socket.emit('ready', { deviceId: schoolId });
        await saveSessionToFirebase(schoolId); // salva após pronto
    });

    client.on('qr', async (qr) => {
        try {
            const qrDataURL = await QRCode.toDataURL(qr);
            socket.emit('qr', { deviceId: schoolId, qr: qrDataURL });
            console.log(`[📲] QR code emitido para ${schoolId}`);
        } catch (err) {
            console.error(`[❌] Erro ao gerar QR para ${schoolId}:`, err.message);
        }
    });

    client.on('authenticated', async () => {
        console.log(`[🔐] Autenticado: ${schoolId}`);
      
        await saveSessionToFirebase(schoolId);
    });

    client.on('disconnected', async () => {
        console.log(`[⚠️] Desconectado: ${schoolId}`);
        await saveSessionToFirebase(schoolId);
    });

    client.initialize();
    return client;
}

// =============== SOCKET.IO ===============
io.on('connection', (socket) => {
  console.log(`Cliente conectado no Socket.IO: ${socket.id}`);

  socket.on('startSession', async ({ deviceId }) => {
    if (!deviceId) {
      socket.emit('error', 'deviceId é obrigatório');
      return;
    }

    // Bloqueia chamadas simultâneas para o mesmo deviceId
    if (activeSockets.has(deviceId)) {
      const oldSocketId = activeSockets.get(deviceId);
      if (oldSocketId !== socket.id) {
        activeSockets.delete(deviceId);
        console.log('Conexão já existente da mesma escola cancelada!')
      }
    }
  
    activeSockets.set(deviceId, socket.id);
    
    if (clients.has(deviceId)) {
      const client = clients.get(deviceId);
    
      if (client.info?.wid) {
        socket.emit('info', `Sessão ${deviceId} já está ativa.`);
        return;
      }
    
      try {
        await client.destroy(); // Garante que a sessão anterior seja encerrada
        clients.delete(deviceId);
        console.log(`Sessão travada ${deviceId} encerrada.`);
      } catch (e) {
        console.warn(`Erro ao destruir sessão travada ${deviceId}:`, e.message);
      }
    }
    try {
      const client = await createClient(deviceId, socket);
      clients.set(deviceId, client);
      socket.emit('started', { deviceId });
    } catch (error) {
      console.error(`Erro ao iniciar cliente ${deviceId}:`, error);
      socket.emit('error', `Erro ao iniciar sessão ${deviceId}`);
    }
  });

  socket.on('stopSession', ({ deviceId }) => {
    const client = clients.get(deviceId);
    if (client) {
      client.destroy();
      clients.delete(deviceId);
      for (const [deviceId, sockId] of activeSockets.entries()) {
        if (sockId === socket.id) {
          activeSockets.delete(deviceId);
        }
      }
      socket.emit('stopped', { deviceId });
      console.log(`Sessão ${deviceId} parada.`);
    }
  });
});

// =============== ENDPOINT PARA ENVIAR MENSAGEM ===============
app.post('/enviar-whatsapp', async (req, res) => {
  const { deviceId, numero, mensagem } = req.body;
  if (!deviceId || !numero || !mensagem) {
    return res.status(400).json({ erro: 'deviceId, número e mensagem são obrigatórios.' });
  }

  const client = clients.get(deviceId);
  if (!client) {
    return res.status(404).json({ erro: 'Cliente WhatsApp não encontrado para o deviceId informado.' });
  }

  try {
    await client.sendMessage(`${numero}@c.us`, mensagem);
    console.log(`Mensagem enviada para ${numero} via sessão ${deviceId}.`);
    return res.json({ sucesso: true, enviado: true });
  } catch (error) {
    console.error(`Erro ao enviar mensagem via ${deviceId}:`, error);
    return res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// =============== ENDPOINT TESTE ===============
app.get('/', (req, res) => {
  res.send('Servidor WhatsApp Web.js com múltiplas sessões e persistência no Firebase está funcionando.');
});

// =============== INICIAR SERVIDOR ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
