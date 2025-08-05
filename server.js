const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { RemoteAuthStore } = require('@wppconnect-team/remote-auth');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');

// =============== CONFIG FIREBASE ===============
const serviceAccount = require('./pedagogia-systematrix-firebase-adminsdk.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix-default-rtdb.firebaseio.com'
});

const db = admin.database();

// =============== EXPRESS E SOCKET.IO ===============
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// =============== GERENCIAMENTO DE CLIENTES ===============
const clients = new Map();       // Map<deviceId, Client>
const activeSockets = new Map(); // Map<deviceId, socketId>

// =============== CLIENTE COM RemoteAuth ===============
function createFirebaseStore(deviceId) {
    return new RemoteAuthStore({
        store: db.ref(`whatsapp-sessions/${deviceId}`),
        backupSyncIntervalMs: 30000 // salva a cada 30 segundos
    });
}

function createClient(deviceId, socket) {
    const store = createFirebaseStore(deviceId);

    const client = new Client({
        authStrategy: new RemoteAuth({
            store,
            backupSyncIntervalMs: 30000,
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', async (qr) => {
        const qrDataURL = await QRCode.toDataURL(qr);
        socket.emit('qr', { deviceId, qr: qrDataURL });
        console.log(`[📲] QR code emitido para ${deviceId}`);
    });

    client.on('ready', () => {
        socket.emit('ready', { deviceId });
        console.log(`[✅] WhatsApp pronto para ${deviceId}`);
    });

    client.on('authenticated', () => {
        console.log(`[🔐] Autenticado: ${deviceId}`);
    });

    client.on('disconnected', () => {
        socket.emit('disconnected', { deviceId });
        console.log(`[⚠️] Desconectado: ${deviceId}`);
    });

    client.initialize();
    return client;
}

// =============== SOCKET.IO ===============
io.on('connection', (socket) => {
    console.log(`Socket conectado: ${socket.id}`);

    socket.on('startSession', async ({ deviceId }) => {
        if (!deviceId) {
            socket.emit('error', 'deviceId é obrigatório');
            return;
        }

        if (activeSockets.has(deviceId)) {
            const oldSocketId = activeSockets.get(deviceId);
            if (oldSocketId !== socket.id) {
                activeSockets.delete(deviceId);
                console.log('Conexão anterior encerrada.');
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
                await client.destroy();
                clients.delete(deviceId);
                console.log(`Sessão ${deviceId} reiniciada.`);
            } catch (e) {
                console.warn(`Erro ao destruir sessão ${deviceId}:`, e.message);
            }
        }

        try {
            const client = createClient(deviceId, socket);
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
            for (const [dId, sockId] of activeSockets.entries()) {
                if (sockId === socket.id) {
                    activeSockets.delete(dId);
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
        return res.status(404).json({ erro: 'Cliente não encontrado.' });
    }

    try {
        await client.sendMessage(`${numero}@c.us`, mensagem);
        console.log(`Mensagem enviada para ${numero} via ${deviceId}`);
        return res.json({ sucesso: true });
    } catch (error) {
        console.error(`Erro ao enviar mensagem via ${deviceId}:`, error);
        return res.status(500).json({ sucesso: false, erro: error.message });
    }
});

// =============== ENDPOINT TESTE ===============
app.get('/', (req, res) => {
    res.send('Servidor WhatsApp com RemoteAuth funcionando.');
});

// =============== INICIAR SERVIDOR ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
