// whatsapp-manager.js

// Importação correta para a versão estável
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Não precisamos mais de 'axios' ou 'firebase-admin' para gerenciar a sessão!
// O Firebase continua sendo usado no server.js para outras coisas, mas não aqui.

const clients = {}; // Objeto para armazenar as instâncias dos clientes por schoolId

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Iniciando inicialização do cliente com LocalAuth...`);
    
    // O clientId garante que cada escola tenha sua própria pasta de sessão
    // dentro do disco persistente. Ex: /.wwebjs_auth/session-ll3eR1xOgq...
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: schoolId, 
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Necessário para rodar no Render
        }
    });

    client.on('qr', (qr) => {
        console.log(`[${schoolId}] QR Code recebido. A pasta da sessão será criada no disco persistente após a leitura.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[${schoolId}] Erro ao gerar QR Code:`, err);
                return;
            }
            socket.emit('qr', url);
            socket.emit('message', { text: 'QR Code recebido. Escaneie com seu celular.' });
        });
    });

    // Evento 'authenticated' não é mais necessário para salvar a sessão,
    // a biblioteca faz isso automaticamente.

    client.on('ready', () => {
        console.log(`[${schoolId}] Cliente do WhatsApp está pronto!`);
        clients[schoolId] = client;
        socket.emit('ready');
        socket.emit('message', { text: 'WhatsApp conectado com sucesso!' });
    });

    client.on('auth_failure', (msg) => {
        console.error(`[${schoolId}] Falha na autenticação:`, msg);
        // Em caso de falha, pode ser necessário limpar a pasta da sessão manualmente
        // no disco persistente se o problema persistir.
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
