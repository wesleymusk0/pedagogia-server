// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// Importa as funções do nosso gerenciador
const { initializeClient, sendMessage, cleanupClient } = require('./whatsapp-manager');

const app = express();
const server = http.createServer(app);
const corsOptions = { origin: "*", methods: ["GET", "POST"] };
app.use(cors(corsOptions));
const io = new Server(server, { cors: corsOptions });
app.use(express.json());

// Objeto para mapear qual socket ID pertence a qual escola
const socketSchoolMap = {};

app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;
    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ sucesso: false, mensagem: "Dados incompletos." });
    }
    const result = await sendMessage(schoolId, numero, mensagem);
    res.status(result.sucesso ? 200 : 500).json(result);
});

io.on('connection', (socket) => {
    console.log(`Novo cliente conectado: ${socket.id}`);

    socket.on('iniciar-sessao', (schoolId) => {
        if (!schoolId) {
            console.log('Tentativa de iniciar sessão sem schoolId.');
            return;
        }
        // Mapeia este socket a uma escola
        socketSchoolMap[socket.id] = schoolId;
        initializeClient(schoolId, socket);
    });

    socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
        const schoolId = socketSchoolMap[socket.id];
        if (schoolId) {
            // Se o socket que desconectou estava gerenciando uma sessão, limpe-a
            cleanupClient(schoolId);
            // Remove o mapeamento
            delete socketSchoolMap[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
