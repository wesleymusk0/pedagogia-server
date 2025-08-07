const { Client, RemoteAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const qrcode = require('qrcode');

// Inicialize o Firebase Admin SDK (se ainda não estiver inicializado)
if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_KEY_JSON
        ? JSON.parse(process.env.FIREBASE_KEY_JSON)
        : require('./firebase-service-account.json');

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://pedagogia-systematrix-default-rtdb.firebaseio.com/`
    });
}
const db = admin.database();

// ===== Classe FirebaseStore =====
class FirebaseStore {
    constructor(clientId) {
        if (!clientId) throw new Error('O clientId (schoolId) é obrigatório.');
        this.path = `whatsapp_sessions/${clientId}`;
        this.dbRef = db.ref(this.path);
        this.sessionData = null;
    }

    async save(session) {
        console.log(`[FirebaseStore] Salvando sessão para ${this.path}`);
        this.sessionData = session;
        await this.dbRef.set(session);
    }

    async extract() {
        if (!this.sessionData) {
            console.log(`[FirebaseStore] Nenhuma sessão local em memória. Buscando no Firebase...`);
            const snapshot = await this.dbRef.once('value');
            const data = snapshot.val();
            this.sessionData = data;
            return data;
        } else {
            console.log(`[FirebaseStore] Sessão carregada da memória local.`);
            return this.sessionData;
        }
    }

    async delete() {
        console.log(`[FirebaseStore] Deletando sessão de ${this.path}`);
        this.sessionData = null;
        await this.dbRef.remove();
    }

    async sessionExists() {
        const snapshot = await this.dbRef.once('value');
        const exists = snapshot.exists();
        console.log(`[FirebaseStore] Verificando se sessão existe para ${this.path}: ${exists}`);
        return exists;
    }
}

// Armazena cliente, socket e estado da sessão
const clients = {}; // { schoolId: { client, socket } }
const sessionStates = {}; // { schoolId: 'initializing' | 'ready' | 'disconnected' }

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Requisição para iniciar sessão pelo socket ${socket.id}`);

    // Impede reinicialização se a sessão já estiver em estado válido
    const estadoAtual = sessionStates[schoolId];
    if (estadoAtual === 'initializing' || estadoAtual === 'ready') {
        console.log(`[${schoolId}] Sessão já está em estado '${estadoAtual}'. Ignorando nova inicialização.`);
        return;
    }

    // Remove cliente anterior, se houver
    if (clients[schoolId]) {
        console.log(`[${schoolId}] Encerrando cliente anterior do socket ${clients[schoolId].socket.id}`);
        clients[schoolId].socket.emit('session_terminated', 'Outra aba ou usuário iniciou uma nova conexão.');
        await clients[schoolId].client.destroy();
        delete clients[schoolId];
        sessionStates[schoolId] = 'disconnected';
    }

    // Marca como inicializando
    sessionStates[schoolId] = 'initializing';
    const store = new FirebaseStore(schoolId);

    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: schoolId,
            store,
            backupSyncIntervalMs: 300000 // 5 minutos
        }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    // ========== EVENTOS ==========
    client.on('qr', (qr) => {
        if (sessionStates[schoolId] === 'disconnected') {
            console.log(`[${schoolId}] QR ignorado: sessão foi marcada como desconectada.`);
            return;
        }

        console.log(`[${schoolId}] QR Code recebido. Emitindo para o socket ${socket.id}`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[${schoolId}] Erro ao gerar QR Code:`, err);
                return;
            }
            socket.emit('qr', url);
        });
    });

    client.on('ready', () => {
        sessionStates[schoolId] = 'ready';
        clients[schoolId] = { client, socket };
        console.log(`[${schoolId}] Cliente pronto. Sessão ativa.`);
        socket.emit('ready');
    });

    client.on('authenticated', () => {
        console.log(`[${schoolId}] Sessão autenticada com sucesso.`);
    });

    client.on('auth_failure', async (msg) => {
        console.error(`[${schoolId}] Falha na autenticação:`, msg);
        sessionStates[schoolId] = 'disconnected';
        await store.delete();
        delete clients[schoolId];
        socket.emit('disconnected');
    });

    client.on('disconnected', async (reason) => {
        console.log(`[${schoolId}] Cliente desconectado:`, reason);
        sessionStates[schoolId] = 'disconnected';
        await store.delete();
        delete clients[schoolId];
        socket.emit('disconnected');
    });

    // ========== Inicialização ==========
    try {
        await client.initialize();
        console.log(`[${schoolId}] Cliente inicializado com sucesso.`);
    } catch (err) {
        console.error(`[${schoolId}] Erro ao inicializar cliente:`, err);
        sessionStates[schoolId] = 'disconnected';
    }
};

// ========== Envio de mensagem ==========
const sendMessage = async (schoolId, numero, mensagem) => {
    const session = clients[schoolId];
    if (!session || sessionStates[schoolId] !== 'ready') {
        return { sucesso: false, mensagem: "Sessão não está pronta." };
    }

    try {
        const chatId = `${numero.replace(/\D/g, '')}@c.us`;
        await session.client.sendMessage(chatId, mensagem);
        console.log(`[${schoolId}] Mensagem enviada para ${numero}`);
        return { sucesso: true, mensagem: "Mensagem enviada." };
    } catch (error) {
        console.error(`[${schoolId}] Erro ao enviar mensagem para ${numero}:`, error);
        return { sucesso: false, mensagem: "Erro ao enviar mensagem." };
    }
};

// ========== Limpeza manual ==========
const cleanupClient = async (schoolId) => {
    if (clients[schoolId]) {
        console.log(`[${schoolId}] Limpando cliente após desconexão.`);
        await clients[schoolId].client.destroy();
        delete clients[schoolId];
    }
    sessionStates[schoolId] = 'disconnected';
};

module.exports = {
    initializeClient,
    sendMessage,
    cleanupClient
};
