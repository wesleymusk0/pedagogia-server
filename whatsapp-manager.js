const { Client, RemoteAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const qrcode = require('qrcode');

// === Inicializa Firebase apenas uma vez ===
if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_KEY_JSON
        ? JSON.parse(process.env.FIREBASE_KEY_JSON)
        : require('./firebase-service-account.json');

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://pedagogia-systematrix-default-rtdb.firebaseio.com/',
    });
}
const db = admin.database();

// === Classe de armazenamento remoto embutida ===
class FirebaseRemoteAuthStore {
    constructor(clientId) {
        if (!clientId) throw new Error('O clientId (schoolId) é obrigatório.');
        this.clientId = clientId;
        this.dbRef = db.ref(`whatsapp_sessions/${clientId}`);
        this.sessionData = null;
    }

    async save(data) {
        console.log(`[Store] Salvando sessão: ${this.clientId}`);
        this.sessionData = data;
        await this.dbRef.set(data);
    }

    async extract() {
        if (this.sessionData) {
            console.log(`[Store] Sessão em cache: ${this.clientId}`);
            return this.sessionData;
        }

        console.log(`[Store] Carregando sessão do Firebase: ${this.clientId}`);
        const snapshot = await this.dbRef.once('value');
        const data = snapshot.val();
        this.sessionData = data;
        return data || null;
    }

    async delete() {
        console.log(`[Store] Deletando sessão: ${this.clientId}`);
        this.sessionData = null;
        await this.dbRef.remove();
    }

    async sessionExists() {
        const snapshot = await this.dbRef.once('value');
        const exists = snapshot.exists();
        console.log(`[Store] Sessão existe para ${this.clientId}: ${exists}`);
        return exists;
    }
}

// === Gerenciador de clientes ===
const clients = {};

/**
 * Inicializa um cliente WhatsApp para a escola especificada
 * @param {string} schoolId 
 * @param {Socket} socket 
 */
const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Iniciando cliente para socket ${socket.id}`);

    // Se já existir, encerra cliente antigo
    if (clients[schoolId]) {
        console.log(`[${schoolId}] Sessão duplicada detectada. Encerrando anterior...`);
        clients[schoolId].socket.emit('session_terminated', 'Uma nova conexão foi iniciada.');
        await clients[schoolId].client.destroy();
        delete clients[schoolId];
    }

    const store = new FirebaseRemoteAuthStore(schoolId);

    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: schoolId,
            store: store,
            backupSyncIntervalMs: null, // evita arquivos .zip locais
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    let isDisconnected = false;

    client.on('qr', (qr) => {
        if (isDisconnected) {
            console.log(`[${schoolId}] QR ignorado (cliente desconectado).`);
            return;
        }

        console.log(`[${schoolId}] QR code recebido.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[${schoolId}] Erro ao gerar QR:`, err);
                return;
            }
            socket.emit('qr', url);
        });
    });

    client.on('ready', () => {
        console.log(`[${schoolId}] Cliente pronto.`);
        clients[schoolId] = { client, socket };
        socket.emit('ready');
    });

    client.on('auth_failure', async (msg) => {
        console.error(`[${schoolId}] Falha de autenticação:`, msg);
        await store.delete();
        isDisconnected = true;
        socket.emit('disconnected');
        delete clients[schoolId];
    });

    client.on('disconnected', async (reason) => {
        console.log(`[${schoolId}] Cliente desconectado: ${reason}`);
        await store.delete();
        isDisconnected = true;
        socket.emit('disconnected');
        delete clients[schoolId];
    });

    try {
        await client.initialize();
    } catch (err) {
        console.error(`[${schoolId}] Erro ao inicializar cliente:`, err);
        isDisconnected = true;
        socket.emit('disconnected');
        delete clients[schoolId];
    }
};

/**
 * Envia mensagem pelo cliente de uma escola
 * @param {string} schoolId 
 * @param {string} numero 
 * @param {string} mensagem 
 * @returns {Object}
 */
const sendMessage = async (schoolId, numero, mensagem) => {
    if (!clients[schoolId]) {
        return { sucesso: false, mensagem: "Sessão não iniciada para esta escola." };
    }

    try {
        const chatId = `${numero.replace(/\D/g, '')}@c.us`;
        await clients[schoolId].client.sendMessage(chatId, mensagem);
        return { sucesso: true, mensagem: "Mensagem enviada." };
    } catch (error) {
        console.error(`[${schoolId}] Erro ao enviar mensagem:`, error);
        return { sucesso: false, mensagem: "Falha ao enviar mensagem." };
    }
};

/**
 * Limpa cliente e encerra sessão ao desconectar socket
 * @param {string} schoolId 
 */
const cleanupClient = async (schoolId) => {
    if (clients[schoolId]) {
        console.log(`[${schoolId}] Encerrando sessão por desconexão de socket.`);
        await clients[schoolId].client.destroy();
        delete clients[schoolId];
        console.log(`[${schoolId}] Sessão encerrada com sucesso.`);
    }
};

module.exports = {
    initializeClient,
    sendMessage,
    cleanupClient
};
