// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { initializeClient, sendMessage } = require('./whatsapp-manager');

const app = express();
const server = http.createServer(app);

// Configuração do CORS para Express e Socket.IO
const corsOptions = {
    origin: "*", // Em produção, restrinja para a URL do seu frontend
    methods: ["GET", "POST"]
};
app.use(cors(corsOptions));

const io = new Server(server, {
    cors: corsOptions
});

app.use(express.json());

// Rota para o frontend enviar mensagens
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;

    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ sucesso: false, mensagem: "Dados incompletos." });
    }

    const result = await sendMessage(schoolId, numero, mensagem);
    res.status(result.sucesso ? 200 : 500).json(result);
});

// Lógica de conexão do Socket.IO
io.on('connection', (socket) => {
    console.log(`Novo cliente conectado: ${socket.id}`);

    socket.on('iniciar-sessao', (schoolId) => {
        if (!schoolId) {
            console.log('Tentativa de iniciar sessão sem schoolId.');
            return;
        }
        console.log(`Cliente ${socket.id} solicitou sessão para a escola: ${schoolId}`);
        initializeClient(schoolId, socket);
    });
    
    // Opcional: para o upload manual de sessão que você tem no frontend
    socket.on('upload-session', (data) => {
        const { sessionId, sessionData } = data;
        if (sessionId && sessionData) {
            console.log(`Recebido upload manual de sessão para ${sessionId}. Reiniciando cliente...`);
            // Aqui você pode adaptar para re-inicializar com os dados recebidos
            // A lógica automática já deve cobrir isso, mas é um ponto de extensão.
        }
    });

    socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
