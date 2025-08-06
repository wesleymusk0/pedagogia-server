const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// 🔐 Inicializa Firebase com credenciais do ambiente
const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY_JSON);
admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: 'https://pedagogia-systematrix-default-rtdb.firebaseio.com',
});

const db = admin.database();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

const SESSIONS_PATH = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_PATH)) fs.mkdirSync(SESSIONS_PATH);

// 📦 Restaura sessões salvas no Firebase para o disco
async function restaurarSessoesDoFirebase() {
    const snapshot = await db.ref('whatsapp-sessoes').once('value');
    const todas = snapshot.val();
    if (!todas) return;

    for (const sessionId in todas) {
        const arquivos = todas[sessionId];
        const pasta = path.join(SESSIONS_PATH, sessionId);
        if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });

        for (const nomeArquivo in arquivos) {
            const conteudo = arquivos[nomeArquivo];
            fs.writeFileSync(path.join(pasta, nomeArquivo), conteudo, 'utf8');
        }

        console.log(`📁 Sessão ${sessionId} restaurada`);
        iniciarCliente(sessionId); // Já inicia cliente após restaurar
    }
}

// 💾 Salva sessão no Firebase Database
async function salvarSessaoNoFirebase(sessionId) {
    const pasta = path.join(SESSIONS_PATH, sessionId);
    if (!fs.existsSync(pasta)) {
        console.warn(`❌ Pasta de sessão não encontrada: ${pasta}`);
        return;
    }

    if (arquivos.length === 0) {
        console.warn(`❌ Nenhum arquivo encontrado na sessão: ${pasta}`);
    }

    const arquivos = fs.readdirSync(pasta);
    const dados = {};

    for (const arquivo of arquivos) {
        const conteudo = fs.readFileSync(path.join(pasta, arquivo), 'utf8');
        dados[arquivo] = conteudo;
    }

    await db.ref(`whatsapp-sessoes/${sessionId}`).set(dados);
    console.log(`✅ Sessão ${sessionId} salva no Firebase.`);
}

// 🧠 Lista de instâncias de clientes WhatsApp
const clientes = {};

// 🚀 Inicia cliente WhatsApp
function iniciarCliente(sessionId) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId, dataPath: SESSIONS_PATH }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true,
        }
    });

    client.on('qr', async qr => {
        const qrCode = await QRCode.toDataURL(qr);
        io.to(sessionId).emit('qr', qrCode);
        console.log(`📱 QR gerado para sessão ${sessionId}`);
    });

    client.on('ready', async () => {
        console.log(`✅ Sessão ${sessionId} pronta`);
        await salvarSessaoNoFirebase(sessionId);
        io.to(sessionId).emit('ready');
    });

    client.on('authenticated', () => {
        console.log(`🔐 Sessão ${sessionId} autenticada`);
    });

    client.on('disconnected', async () => {
        console.log(`⚠️ Sessão ${sessionId} desconectada`);
        await db.ref(`whatsapp-sessoes/${sessionId}`).remove();
        delete clientes[sessionId];
        io.to(sessionId).emit('disconnected');
    });

    client.initialize();
    clientes[sessionId] = client;
}

// 📲 Socket.io para comunicação com o frontend
io.on('connection', socket => {
    console.log('🔗 Socket conectado');

    socket.on('iniciar-sessao', async sessionId => {
        socket.join(sessionId);
        if (!clientes[sessionId]) {
            iniciarCliente(sessionId);
        } else {
            const client = clientes[sessionId];
            if (client.info && client.info.wid) {
                // Sessão realmente está pronta
                socket.emit('ready');
            } else {
                console.log(`ℹ️ Sessão ${sessionId} ainda está inicializando`);
                // Não envia nada — deixa os eventos do client ('qr', 'ready', etc.) fazerem isso
            }
        }
    });
});

// 📤 Rota para enviar mensagem
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;
    const client = clientes[schoolId];
    if (!client) return res.status(404).json({ erro: 'Cliente não encontrado' });

    try {
        const chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(chatId, mensagem);
        res.json({ sucesso: true });
    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao enviar mensagem' });
    }
});

// 🌐 Inicia servidor
const PORT = process.env.PORT || 10000;
server.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    await restaurarSessoesDoFirebase();
});
