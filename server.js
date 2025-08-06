const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const clients = {};

function getSessionFile(schoolId) {
    return path.join(SESSIONS_DIR, `${schoolId}.json`);
}

function verificarConexao(client) {
    return !!(client && client.info && client.info.wid);
}

function ensureSessionDir(schoolId) {
    const authPath = path.join(SESSIONS_DIR, schoolId, 'Default');
    fs.mkdirSync(authPath, { recursive: true });
}

function iniciarSessao(schoolId, socket) {
    const authPath = path.join(SESSIONS_DIR, schoolId);

    // Cria a estrutura de pastas esperada
    ensureSessionDir(schoolId);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: { headless: true, args: ['--no-sandbox'] }
    });

    clients[schoolId] = client;

    client.on('qr', async qr => {
        const qrCode = await QRCode.toDataURL(qr);
        socket.emit('qr', qrCode);
    });

    client.on('ready', () => {
        socket.emit('ready');
        console.log(`✅ WhatsApp conectado: ${schoolId}`);

        const sessionJsonPath = path.join(authPath, 'Default', 'session.json');
        if (fs.existsSync(sessionJsonPath)) {
            const sessionData = fs.readFileSync(sessionJsonPath, 'utf-8');
            socket.emit('download-session', sessionData);
        }
    });

    client.on('authenticated', () => {
        console.log(`🔐 Autenticado: ${schoolId}`);
    });

    client.on('disconnected', () => {
        console.log(`❌ Desconectado: ${schoolId}`);
        socket.emit('disconnected');
        delete clients[schoolId];
    });

    client.initialize();
}

async function verificarSessaoLocal(schoolId, socket) {
    const sessionJsonPath = getSessionFile(schoolId);

    if (!fs.existsSync(sessionJsonPath)) {
        console.log(`📭 Sessão local não encontrada para ${schoolId}`);
        iniciarSessao(schoolId, socket);
        return;
    }

    iniciarSessao(schoolId, socket);

    // Após 10 segundos, se não estiver conectado, força QR
    setTimeout(() => {
        const client = clients[schoolId];
        if (!verificarConexao(client)) {
            console.log(`⚠️ Sessão inválida para ${schoolId}. Reiniciando para gerar QR...`);
            client.logout().then(() => {
                iniciarSessao(schoolId, socket);
            }).catch(() => {
                iniciarSessao(schoolId, socket);
            });
        }
    }, 10000);
}

// SOCKET.IO
io.on('connection', socket => {
    console.log('🔗 Socket conectado');

    socket.on('iniciar-sessao', async (schoolId) => {
        if (!schoolId) return;
        verificarSessaoLocal(schoolId, socket);
    });

    socket.on('upload-session', ({ sessionId, sessionData }) => {
        if (!sessionId || !sessionData) return;
        const sessionFilePath = getSessionFile(sessionId);
        try {
            fs.writeFileSync(sessionFilePath, sessionData);
            iniciarSessao(sessionId, socket);
        } catch (err) {
            console.error(`❌ Erro ao restaurar sessão ${sessionId}:`, err);
            socket.emit('disconnected');
        }
    });
});

// ENDPOINT DE ENVIO DE MENSAGEM
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;

    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ erro: 'Parâmetros obrigatórios ausentes.' });
    }

    const client = clients[schoolId];
    if (!verificarConexao(client)) {
        return res.status(500).json({ erro: 'Cliente não está conectado.' });
    }

    try {
        const destinatario = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(destinatario, mensagem);
        res.json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ erro: 'Falha ao enviar mensagem.' });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Backend rodando na porta ${PORT}`);
});
