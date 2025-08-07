// whatsapp-manager.js

const { Client, RemoteAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const qrcode = require('qrcode');

// Inicialize o Firebase Admin SDK
const serviceAccount = process.env.FIREBASE_KEY_JSON
    ? JSON.parse(process.env.FIREBASE_KEY_JSON)
    : require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://pedagogia-systematrix-default-rtdb.firebaseio.com`
});

const db = admin.database();

// =======================================================================
// ===                    NOSSA PRÓPRIA FIREBASE STORE                 ===
// ===            Agora com TODOS os métodos necessários               ===
// =======================================================================
class FirebaseStore {
    constructor(clientId) {
        if (!clientId) throw new Error('O clientId (schoolId) é obrigatório.');
        this.path = `whatsapp_sessions/${clientId}`;
        this.dbRef = db.ref(this.path);
    }

    async save(session) {
        console.log(`[FirebaseStore] Salvando sessão para ${this.path}`);
        await this.dbRef.set(session);
    }

    async retrieve() {
        console.log(`[FirebaseStore] Recuperando sessão de ${this.path}`);
        const snapshot = await this.dbRef.once('value');
        return snapshot.val();
    }
    
    async delete() {
        console.log(`[FirebaseStore] Deletando sessão de ${this.path}`);
        await this.dbRef.remove();
    }

    // === MÉTODO ADICIONADO PARA CORRIGIR O ERRO ===
    async sessionExists() {
        const snapshot = await this.dbRef.once('value');
        const exists = snapshot.exists();
        console.log(`[FirebaseStore] Verificando se sessão existe para ${this.path}: ${exists}`);
        return exists;
    }
}
// =======================================================================

const clients = {}; 

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Iniciando inicialização do cliente com nossa FirebaseStore...`);

    const store = new FirebaseStore(schoolId);
    
    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: schoolId,
            store: store,
            backupSyncIntervalMs: 300000 
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`[${schoolId}] QR Code recebido. Enviando para o cliente.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[${schoolId}] Erro ao gerar QR Code:`, err);
                return;
            }
            socket.emit('qr', url);
            socket.emit('message', { text: 'QR Code recebido. Escaneie com seu celular.' });
        });
    });

    client.on('remote_session_saved', () => {
        console.log(`[${schoolId}] Sessão remota salva com sucesso no Firebase!`);
    });

    client.on('ready', () => {
        console.log(`[${schoolId}] Cliente do WhatsApp está pronto!`);
        clients[schoolId] = client;
        socket.emit('ready');
        socket.emit('message', { text: 'WhatsApp conectado com sucesso!' });
    });

    client.on('auth_failure', async (msg) => {
        console.error(`[${schoolId}] Falha na autenticação:`, msg);
        await store.delete();
        socket.emit('disconnected');
    });

    client.on('disconnected', (reason) => {
        console.log(`[${schoolId}] Cliente foi desconectado:`, reason);
        delete clients[schoolId];
        socket.emit('disconnected');
    });

    client.initialize().catch(err => {
        console.error(`[${schoolId}] Erro ao inicializar o cliente: `, err);
    });
};

const sendMessage = async (schoolId, numero, mensagem) => {
    const client = clients[schoolId];
    if (!client) {
        return { sucesso: false, mensagem: "Sessão não iniciada para esta escola." };
    }

    try {
        const chatId = `${numero.replace(/\D/g, '')}@c.us`;
        await client.sendMessage(chatId, mensagem);
        console.log(`[${schoolId}] Mensagem enviada para ${chatId}`);
        return { sucesso: true, mensagem: "Mensagem enviada." };
    } catch (error) {
        console.error(`[${schoolId}] Erro ao enviar mensagem para ${numero}:`, error);
        return { sucesso: false, mensagem: "Falha ao enviar mensagem." };
    }
};

module.exports = {
    initializeClient,
    sendMessage
};
