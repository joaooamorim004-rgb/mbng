const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ ERRO: Variáveis de ambiente não configuradas!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const activeConnections = new Map();

function ensureAuthDir(clienteId) {
  const authDir = path.join(__dirname, 'auth_sessions', clienteId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  return authDir;
}

function cleanPhoneNumber(phone) {
  return phone.replace(/[^0-9]/g, '');
}

async function processIncomingMessage(clienteId, message) {
  try {
    const from = message.key.remoteJid;
    const phoneNumber = cleanPhoneNumber(from.split('@')[0]);
    
    const messageData = {
      id: message.key.id,
      from: phoneNumber,
      timestamp: message.messageTimestamp,
      body: message.message?.conversation || 
            message.message?.extendedTextMessage?.text ||
            '[Mídia]',
      type: Object.keys(message.message || {})[0] || 'text',
    };

    const { error } = await supabase.functions.invoke('whatsapp-webhook', {
      body: {
        cliente_id: clienteId,
        message_data: messageData,
      },
    });

    if (error) {
      console.error('❌ Erro ao enviar para webhook:', error);
    } else {
      console.log('✅ Mensagem processada:', phoneNumber);
    }
  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error);
  }
}

async function createWhatsAppConnection(clienteId) {
  try {
    console.log(`📱 Criando conexão para ${clienteId}`);

    const authDir = ensureAuthDir(clienteId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      getMessage: async () => undefined,
    });

    let qrCode = null;
    let isConnected = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        console.log('🔲 QR Code gerado');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`⚠️ Conexão fechada (${statusCode})`);
        
        if (!shouldReconnect) {
          activeConnections.delete(clienteId);
          await supabase
            .from('clientes')
            .update({ whatsapp_access_token: null })
            .eq('id', clienteId);
        } else {
          setTimeout(() => createWhatsAppConnection(clienteId), 5000);
        }
      } else if (connection === 'open') {
        isConnected = true;
        console.log('✅ WhatsApp conectado!');
        
        await supabase
          .from('clientes')
          .update({ 
            whatsapp_access_token: 'CONNECTED',
            updated_at: new Date().toISOString()
          })
          .eq('id', clienteId);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages) {
        if (!message.key.fromMe && message.message) {
          await processIncomingMessage(clienteId, message);
        }
      }
    });

    activeConnections.set(clienteId, {
      sock,
      qrCode,
      isConnected,
      createdAt: new Date(),
    });

    return { sock, qrCode };
  } catch (error) {
    console.error('❌ Erro ao criar conexão:', error);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MBNG WhatsApp Server',
    mode: 'READ_ONLY',
    activeConnections: activeConnections.size,
    uptime: process.uptime(),
  });
});

app.post('/generate-qr', async (req, res) => {
  try {
    const { cliente_id } = req.body;

    if (!cliente_id) {
      return res.status(400).json({ error: 'cliente_id é obrigatório' });
    }

    console.log(`📲 QR solicitado: ${cliente_id}`);

    const existingConnection = activeConnections.get(cliente_id);
    if (existingConnection?.isConnected) {
      return res.json({
        success: true,
        connected: true,
        message: 'Já conectado',
      });
    }

    const { qrCode } = await createWhatsAppConnection(cliente_id);

    let attempts = 0;
    while (!qrCode && attempts < 300) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const conn = activeConnections.get(cliente_id);
      if (conn?.qrCode) {
        return res.json({
          success: true,
          qr_code: conn.qrCode,
          message: 'QR Code gerado',
        });
      }
      attempts++;
    }

    if (!qrCode) {
      return res.status(408).json({ error: 'Timeout ao gerar QR' });
    }

    res.json({
      success: true,
      qr_code: qrCode,
      message: 'QR Code gerado',
    });
  } catch (error) {
    console.error('❌ Erro em /generate-qr:', error);
    res.status(500).json({ 
      error: 'Erro ao gerar QR',
      details: error.message 
    });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    const { cliente_id } = req.body;

    if (!cliente_id) {
      return res.status(400).json({ error: 'cliente_id obrigatório' });
    }

    const connection = activeConnections.get(cliente_id);
    
    if (connection?.sock) {
      await connection.sock.logout();
    }

    activeConnections.delete(cliente_id);

    await supabase
      .from('clientes')
      .update({ whatsapp_access_token: null })
      .eq('id', cliente_id);

    res.json({ success: true, message: 'Desconectado' });
  } catch (error) {
    console.error('❌ Erro em /disconnect:', error);
    res.status(500).json({ 
      error: 'Erro ao desconectar',
      details: error.message 
    });
  }
});

app.get('/status/:cliente_id', (req, res) => {
  const { cliente_id } = req.params;
  const connection = activeConnections.get(cliente_id);

  if (!connection) {
    return res.json({ connected: false });
  }

  res.json({
    connected: connection.isConnected,
    hasQR: !!connection.qrCode,
    createdAt: connection.createdAt,
  });
});

app.listen(PORT, () => {
  console.log('🚀 MBNG WhatsApp Server ONLINE');
  console.log(`🚀 Porta: ${PORT}`);
  console.log('🚀 Modo: SOMENTE LEITURA');
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Erro:', error);
});
