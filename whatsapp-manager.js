// whatsapp-manager.js

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

class FirebaseStore {
    // ... (código da classe FirebaseStore permanece o mesmo)
    constructor(clientId) {
        if (!clientId) throw new Error('O clientId (schoolId) é obrigatório.');
        this.path = `whatsapp_sessions/${clientId}`;
        this.dbRef = db.ref(this.path);
    }
    async save(session) { console.log(`[FirebaseStore] Salvando sessão para ${this.path}`); await this.dbRef.set(session); }
    async retrieve() { console.log(`[FirebaseStore] Recuperando sessão de ${this.path}`); const snapshot = await this.dbRef.once('value'); return snapshot.val(); }
    async delete() { console.log(`[FirebaseStore] Deletando sessão de ${this.path}`); await this.dbRef.remove(); }
    async sessionExists() { const snapshot = await this.dbRef.once('value'); const exists = snapshot.exists(); console.log(`[FirebaseStore] Verificando se sessão existe para ${this.path}: ${exists}`); return exists; }
}

// Objeto para armazenar não apenas o cliente, mas também o socket associado a ele.
const clients = {}; 

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Solicitação de inicialização recebida do socket ${socket.id}`);

    // ===== LÓGICA DE VERIFICAÇÃO DE DUPLICATAS =====
    if (clients[schoolId]) {
        console.log(`[${schoolId}] Sessão duplicata detectada. Encerrando a sessão antiga do socket ${clients[schoolId].socket.id}`);
        // Notifica o cliente antigo que a sessão foi encerrada
        clients[schoolId].socket.emit('session_terminated', 'Uma nova conexão foi iniciada em outra aba/janela.');
        // Destrói a instância antiga do cliente para liberar recursos
        await clients[schoolId].client.destroy();
        delete clients[schoolId];
        console.log(`[${schoolId}] Sessão antiga encerrada.`);
    }
    // ===============================================

    const store = new FirebaseStore(schoolId);
    
    const client = new Client({
        authStrategy: new RemoteAuth({ clientId: schoolId, store: store, backupSyncIntervalMs: 300000 }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => {
        console.log(`[${schoolId}] QR Code recebido.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) { console.error(`[${schoolId}] Erro ao gerar QR Code:`, err); return; }
            socket.emit('qr', url);
        });
    });

    client.on('ready', () => {
        console.log(`[${schoolId}] Cliente do WhatsApp está pronto. Associando ao socket ${socket.id}`);
        // Armazena a nova instância do cliente E o socket associado
        clients[schoolId] = { client, socket };
        socket.emit('ready');
    });

    // ... (outros eventos como auth_failure, disconnected, etc.)
    client.on('auth_failure', async (msg) => { console.error(`[${schoolId}] Falha na autenticação:`, msg); await store.delete(); delete clients[schoolId]; socket.emit('disconnected'); });
    client.on('disconnected', (reason) => { console.log(`[${schoolId}] Cliente foi desconectado:`, reason); delete clients[schoolId]; socket.emit('disconnected'); });

    client.initialize().catch(err => { console.error(`[${schoolId}] Erro ao inicializar o cliente: `, err); });
};

const sendMessage = async (schoolId, numero, mensagem) => {
    if (!clients[schoolId]) {
        return { sucesso: false, mensagem: "Sessão não iniciada para esta escola." };
    }
    try {
        const chatId = `${numero.replace(/\D/g, '')}@c.us`;
        await clients[schoolId].client.sendMessage(chatId, mensagem);
        return { sucesso: true, mensagem: "Mensagem enviada." };
    } catch (error) {
        console.error(`[${schoolId}] Erro ao enviar mensagem para ${numero}:`, error);
        return { sucesso: false, mensagem: "Falha ao enviar mensagem." };
    }
};

// Nova função para limpar um cliente quando o socket se desconecta
const cleanupClient = async (schoolId) => {
    if (clients[schoolId]) {
        console.log(`[${schoolId}] Limpando cliente devido à desconexão do socket.`);
        await clients[schoolId].client.destroy();
        delete clients[schoolId];
        console.log(`[${schoolId}] Cliente limpo com sucesso.`);
    }
};

module.exports = {
    initializeClient,
    sendMessage,
    cleanupClient // Exporta a nova função
};
