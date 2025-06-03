const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sessions = {};
const qrCodes = {};
const connecting = {};

async function reconnectAllSessions() {
    const sessionsRoot = path.join(__dirname, 'sessoes');

    if (!fs.existsSync(sessionsRoot)) return;

    const users = fs.readdirSync(sessionsRoot, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    console.log('Reconectando sessões:', users);

    for (const userId of users) {
        try {
            await createSession(userId);
        } catch (err) {
            console.error(`Erro ao reconectar sessão ${userId}:`, err);
        }
    }
}

async function createSession(userId) {
    if (sessions[userId]) return; // Já conectada
    if (connecting[userId]) return; // Já em processo de conexão

    connecting[userId] = true;

    const sessionsRoot = path.join(__dirname, 'sessoes');
    if (!fs.existsSync(sessionsRoot)) {
        fs.mkdirSync(sessionsRoot);
    }

    const authPath = path.join(sessionsRoot, userId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Whatsapp Controle', 'Web', '110.0.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrBuffer = await qrcode.toBuffer(qr);
            const qrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
            qrCodes[userId] = qrBase64;
        }

        if (connection === 'open') {
            sessions[userId] = sock;
            delete qrCodes[userId];
            delete connecting[userId];
            console.log(`Sessão conectada para ${userId}`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = DisconnectReason[statusCode] || 'Unknown';

            console.log(`Conexão fechada para ${userId}, motivo: ${reason} (${statusCode})`);

            delete sessions[userId];
            delete qrCodes[userId];
            delete connecting[userId];

            if (statusCode === DisconnectReason.loggedOut) {
                const authPath = path.join(__dirname, 'sessoes', userId);
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    console.log(`Credenciais apagadas para ${userId} após logout.`);
                }
            } else {
                setTimeout(() => createSession(userId), 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

app.get('/:idusuario', async (req, res) => {
    const { idusuario } = req.params;

    if (sessions[idusuario]) {
        return res.json({ con: true });
    }

    // Cria sessão se ainda não estiver conectando nem conectada
    if (!sessions[idusuario] && !connecting[idusuario]) {
        try {
            await createSession(idusuario);
        } catch (error) {
            console.error('Erro ao criar sessão:', error);
            return res.status(500).json({ error: 'Erro ao criar sessão' });
        }
    }

    // Aguarda até que o QR seja gerado ou conexão estabelecida
    let tentativas = 0;
    while (!sessions[idusuario] && !qrCodes[idusuario] && tentativas < 20) {
        await new Promise(r => setTimeout(r, 500));
        tentativas++;
    }

    if (sessions[idusuario]) {
        return res.json({ con: true });
    } else if (qrCodes[idusuario]) {
        return res.json({ qrcode: qrCodes[idusuario] });
    } else {
        return res.status(408).json({ error: 'QR Code não gerado a tempo' });
    }
});

app.get('/:idusuario/:numerowhatsapp/mensagem', async (req, res) => {
    const { idusuario, numerowhatsapp } = req.params;
    const { texto, tipoMidia, caminhoMidia } = req.query;

    if (!sessions[idusuario]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        let mensagem;

        if (tipoMidia && caminhoMidia) {
            switch (tipoMidia.toLowerCase()) {
                case 'imagem':
                    mensagem = {
                        image: { url: caminhoMidia },
                        caption: texto || undefined
                    };
                    break;
                case 'video':
                    mensagem = {
                        video: { url: caminhoMidia },
                        caption: texto || undefined
                    };
                    break;
                case 'documento':
                    try {
                        const urlObj = new URL(caminhoMidia);
                        const originalFileName = decodeURIComponent(path.basename(urlObj.pathname));

                        mensagem = {
                            document: {
                                url: caminhoMidia,
                                mimetype: 'application/octet-stream',
                                fileName: originalFileName || 'document.pdf'
                            },
                            caption: texto || undefined
                        };
                    } catch (e) {
                        mensagem = { text: texto || 'Arquivo inválido' };
                    }
                    break;
                default:
                    mensagem = { text: texto || '' };
            }
        } else {
            mensagem = { text: texto || '' };
        }

        await sessions[idusuario].sendMessage(`${numerowhatsapp}@s.whatsapp.net`, mensagem);
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ error: 'Erro ao enviar mensagem' });
    }
});

app.get('/:idusuario/close', async (req, res) => {
    const { idusuario } = req.params;

    if (sessions[idusuario]) {
    delete sessions[idusuario];
    delete qrCodes[idusuario];
    delete connecting[idusuario];

    const authPath = path.join(__dirname, 'sessoes', idusuario);
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
    }

    res.json({ success: true });

    } else {
        res.status(404).json({ error: 'Sessão não encontrada' });
    }
});

const PORT = process.env.PORT || 48501;
reconnectAllSessions().then(() => {
    app.listen(PORT, () => {
        console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
});
