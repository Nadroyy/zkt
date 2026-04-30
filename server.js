const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const mysql = require('mysql2');
const { createZkTcpService } = require('./services/zkTcpService');
const { createZkLogStore } = require('./services/zkLogStore');
const { createZkbioAccessHttpService } = require('./services/zkbioAccessHttpService');

const app = express();
const PERSON_LEVEL_DYNAMIC_INPUT = 'input_81f0fcc729e7479a8f16f00e2a959c13';

const config = {
    server: {
        port: parseInteger(process.env.PORT, 3000)
    },
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'control_asistencia',
        port: parseInteger(process.env.MYSQL_PORT, 3306)
    },
    zk: {
        ip: process.env.ZK_DEVICE_IP || '',
        port: parseInteger(process.env.ZK_DEVICE_PORT, 4370),
        timeoutMs: parseInteger(process.env.ZK_TIMEOUT_MS, 5000),
        pythonBin: process.env.ZK_PYTHON_BIN || 'python'
    },
    zkbio: {
        baseUrl: resolveBaseUrl(process.env.ZKBIO_URL || 'http://localhost:8098/bioLogin.do'),
        username: process.env.ZKBIO_USER || process.env.ZKBIO_USERNAME || 'admin',
        password: process.env.ZKBIO_PASS || process.env.ZKBIO_PASSWORD || '',
        deptId: process.env.ZKBIO_DEPT_ID || '',
        personLevelId: process.env.ZKBIO_PERSON_LEVEL_ID || '',
        personAreaId: process.env.ZKBIO_PERSON_AREA_ID || '',
        browserToken: process.env.ZKBIO_BROWSER_TOKEN || ''
    }
};

const uploadsDir = path.join(__dirname, 'uploads');
const facesUploadsDir = path.join(uploadsDir, 'faces');
const logsDir = path.join(__dirname, 'logs');
const dataDir = path.join(__dirname, 'data');
const biophotosDir = path.join(dataDir, 'biophotos');
const admsTrafficLogPath = path.join(logsDir, 'adms-traffic.log');
const admsCommandResultsLogPath = path.join(logsDir, 'adms-command-results.log');
const admsBiodataLogPath = path.join(dataDir, 'adms-biodata.log');
const admsBiophotoLogPath = path.join(dataDir, 'adms-biophoto.log');
const admsAttlogLogPath = path.join(dataDir, 'adms-attlog.log');
const admsPersonsLogPath = path.join(dataDir, 'adms-persons.jsonl');
const logStore = createZkLogStore({
    filePath: path.join(__dirname, 'logs.txt'),
    maxEntries: parseInteger(process.env.ZK_LOG_LIMIT, 200)
});
const zkTcpService = createZkTcpService({
    defaults: config.zk,
    logStore
});
const zkbioAccessHttpService = createZkbioAccessHttpService({
    baseUrl: config.zkbio.baseUrl,
    logStore
});

let comandosPendientes = [];
let admsCommandId = 1;

ensureDirectory(uploadsDir);
ensureDirectory(facesUploadsDir);
ensureDirectory(logsDir);
ensureDirectory(dataDir);
ensureDirectory(biophotosDir);

const dbPool = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
const db = dbPool.promise();

db.getConnection()
    .then(connection => {
        connection.release();
        console.log('MySQL conectado');
    })
    .catch(error => {
        console.error('Error conectando a MySQL:', error.message);
        process.exit(1);
    });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        cb(null, uniqueName + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: parseInteger(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024
    },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
            return;
        }

        cb(new Error('Solo se permiten imagenes'));
    }
});

app.set('trust proxy', true);
app.use('/iclock', express.text({ type: '*/*', limit: '2mb' }));
app.use('/iclock', admsTrafficLogger);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.post('/subir-foto', upload.single('foto'), asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const nombre = normalizeName(req.body.nombre);

    if (!pin || !nombre) {
        return res.status(400).json({ ok: false, error: 'Faltan pin o nombre validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No se recibio ninguna foto' });
    }

    const foto = req.file.filename;

    await db.query(
        `INSERT INTO usuarios (pin, nombre, foto, estado)
         VALUES (?, ?, ?, 'pendiente')
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), foto = VALUES(foto), estado = 'pendiente'`,
        [pin, nombre, foto]
    );

    logStore.info('adms.photo.upload', {
        pin,
        nombre,
        foto
    });

    res.json({
        ok: true,
        mensaje: 'Usuario creado. Debe registrar su rostro en el dispositivo.',
        pin,
        nombre,
        foto,
        url: `/uploads/${foto}`
    });
}));

app.post('/enviar-template', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const template = typeof req.body.template === 'string' ? req.body.template.trim() : '';

    if (!pin || !template) {
        return res.status(400).json({ ok: false, error: 'Faltan pin o template' });
    }

    if (template.length < 100) {
        return res.status(400).json({ ok: false, error: 'Template invalido o demasiado corto' });
    }

    encolarComando(`C:DATA UPDATE USERINFO PIN=${pin} Name=Clonado${pin} Password=`);
    encolarComando(`C:DATA UPDATE BIODATA PIN=${pin} Tmp=${template}`);

    logStore.info('adms.template.queued', {
        pin,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        mensaje: 'Template encolado para envio al dispositivo',
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/actualizar-usuario', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const nuevoNombre = normalizeName(req.body.nuevoNombre);

    if (!pin || !nuevoNombre) {
        return res.status(400).json({ ok: false, error: 'Faltan pin o nuevoNombre validos' });
    }

    const [result] = await db.query('UPDATE usuarios SET nombre = ? WHERE pin = ?', [nuevoNombre, pin]);

    if (result.affectedRows === 0) {
        return res.status(404).json({ ok: false, error: `Usuario con PIN ${pin} no existe` });
    }

    logStore.info('adms.user.updated', {
        pin,
        nuevoNombre
    });

    res.json({ ok: true, mensaje: `Nombre actualizado a "${nuevoNombre}"` });
}));

app.post('/zkbio/user', upload.single('foto'), asyncHandler(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const pin = normalizePin(req.body.pin);
    const name = normalizeName(req.body.name || req.body.nombre);

    if (!pin || !name) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin numerico y name valido' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'La foto es obligatoria' });
    }

    let browserToken = config.zkbio.browserToken;
    let formEntries = null;

    try {
        const result = await zkbioAccessHttpService.login(config.zkbio.username, config.zkbio.password);
        browserToken = result.browserToken || config.zkbio.browserToken;
        formEntries = buildZkbioUserFormEntries({
            pin,
            name,
            deptId: config.zkbio.deptId,
            personLevelId: config.zkbio.personLevelId,
            personAreaId: config.zkbio.personAreaId,
            browserToken
        });

        const createResult = await zkbioAccessHttpService.createUserWithPhoto({
            pin,
            name,
            personPhoto: req.file.path,
            formEntries
        });

        await db.query(
            `INSERT INTO usuarios (pin, nombre, foto, estado)
             VALUES (?, ?, ?, 'activo')
             ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), foto = VALUES(foto), estado = 'activo'`,
            [pin, name, req.file.filename]
        );

        const durationMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));

        return res.status(200).json({
            ok: createResult.ok === true,
            action: 'created',
            pin,
            name,
            ret: createResult.data?.ret ?? '',
            msg: createResult.data?.msg ?? '',
            status: createResult.status ?? '',
            durationMs
        });
    } catch (error) {
        if (error.code === 'ZKBIO_USER_ALREADY_EXISTS') {
            const updateFormEntries = formEntries || buildZkbioUserFormEntries({
                pin,
                name,
                deptId: config.zkbio.deptId,
                personLevelId: config.zkbio.personLevelId,
                personAreaId: config.zkbio.personAreaId,
                browserToken
            });

            const updateResult = await zkbioAccessHttpService.updateUserWithPhoto({
                pin,
                name,
                personPhoto: req.file.path,
                formEntries: updateFormEntries
            });

            await db.query(
                `INSERT INTO usuarios (pin, nombre, foto, estado)
                 VALUES (?, ?, ?, 'activo')
                 ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), foto = VALUES(foto), estado = 'activo'`,
                [pin, name, req.file.filename]
            );

            const durationMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));

            logStore.info('zkbio.user.updated', {
                pin,
                durationMs
            });

            return res.status(200).json({
                ok: updateResult.ok === true,
                action: 'updated',
                pin,
                name,
                ret: updateResult.data?.ret ?? '',
                msg: updateResult.data?.msg ?? '',
                status: updateResult.status ?? '',
                durationMs
            });
        }

        throw error;
    }
}));

app.all('/iclock/getrequest', asyncHandler(async (_req, res) => {
    sendPlainText(res, flushPendingCommands());
}));

app.all('/iclock/cdata', asyncHandler(async (req, res) => {
    const body = getRawIclockBody(req);

    logStore.info('adms.request.received', {
        endpoint: '/iclock/cdata',
        ip: req.ip,
        query: req.query,
        bodyLength: body.length
    });

    if (!body) {
        return sendPlainText(res, flushPendingCommands());
    }

    await procesarMensajeUser(body);
    await procesarBiodata(body);
    await procesarBiophotos(body);

    const registros = procesarRegistros(body);
    for (const registro of registros) {
        logStore.info('adms.attendance.received', registro);
        fs.appendFileSync(
            path.join(__dirname, 'asistencias.txt'),
            `[${new Date().toISOString()}] PIN: ${registro.pin} - ${registro.fecha} - ${registro.metodoTexto}\n`
        );
    }

    persistirAttlog(registros, req);

    sendPlainText(res, flushPendingCommands());
}));

app.all('/iclock/devicecmd', asyncHandler(async (req, res) => {
    const result = parseAdmsDevicecmdResult(req);

    logStore.info('adms.devicecmd.received', {
        ip: req.ip,
        query: req.query,
        sn: result.sn,
        id: result.id,
        return: result.returnValue,
        cmd: result.cmd,
        bodyLength: result.rawBody.length
    });

    appendAdmsCommandResultLog({
        timestamp: new Date().toISOString(),
        ip: req.ip,
        originalUrl: req.originalUrl,
        sn: result.sn,
        id: result.id,
        return: result.returnValue,
        cmd: result.cmd,
        body: result.rawBody
    });

    sendPlainText(res, 'OK');
}));

app.post('/adms/queue-user', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const admsName = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const admsPassword = normalizeAdmsQueueField(rawPassword, 24, false);

    if (!pin || !admsName) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin numerico y name valido' });
    }

    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name: admsName,
        password: admsPassword,
        verify: 0
    });

    logStore.info('adms.queue-user.enqueued', {
        pin,
        name: admsName,
        commandId: userCommand.commandId,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        commandId: userCommand.commandId,
        command: userCommand.command,
        pendingCommands: comandosPendientes.length
    });
}));

app.get('/adms/biodata', asyncHandler(async (_req, res) => {
    res.json(readJsonLinesFile(admsBiodataLogPath));
}));

app.get('/adms/biophotos', asyncHandler(async (_req, res) => {
    res.json(readJsonLinesFile(admsBiophotoLogPath));
}));

app.get('/adms/attendance', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.query.pin);
    res.json(readAttendanceEntries({
        pin,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit
    }));
}));

app.get('/adms/attendance/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    res.json(readAttendanceEntries({
        pin,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit
    }));
}));

app.get('/adms/attendance-summary', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.query.pin);
    const date = normalizeDateFilter(req.query.date);

    if (!pin || !date) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin y date validos' });
    }

    res.json(buildAttendanceSummary(pin, date));
}));

app.post('/adms/queue-user-verify', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const admsName = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const admsPassword = normalizeAdmsQueueField(rawPassword, 24, false);
    const verify = Number.parseInt(req.body.verify, 10);

    if (!pin || !admsName || !admsPassword || !Number.isInteger(verify) || verify < 0 || verify > 255) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name, password y verify validos' });
    }

    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name: admsName,
        password: admsPassword,
        verify
    });

    logStore.info('adms.queue-user-verify.enqueued', {
        pin,
        name: admsName,
        verify,
        commandId: userCommand.commandId,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        commandId: userCommand.commandId,
        command: userCommand.command,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/queue-copy-face', asyncHandler(async (req, res) => {
    const sourcePin = normalizePin(req.body.sourcePin);
    const targetPin = normalizePin(req.body.targetPin);

    if (!sourcePin || !targetPin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar sourcePin y targetPin validos' });
    }

    const faceCommands = enqueueAdmsFaceCopyCommands(sourcePin, targetPin);

    logStore.info('adms.queue-copy-face.enqueued', {
        sourcePin,
        targetPin,
        biophotoCommandId: faceCommands.commandIds.biophoto,
        biodataCommandId: faceCommands.commandIds.biodata,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        sourcePin,
        targetPin,
        commandIds: faceCommands.commandIds,
        summary: faceCommands.summary,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/enroll-user-with-face', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);
    const sourceFacePin = normalizePin(req.body.sourceFacePin);

    if (!pin || !name || !sourceFacePin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name y sourceFacePin validos' });
    }

    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name,
        password,
        verify: 0
    });
    const faceCommands = enqueueAdmsFaceCopyCommands(sourceFacePin, pin);

    logStore.info('adms.enroll-user-with-face.enqueued', {
        pin,
        sourceFacePin,
        userCommandId: userCommand.commandId,
        biophotoCommandId: faceCommands.commandIds.biophoto,
        biodataCommandId: faceCommands.commandIds.biodata,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        pin,
        userCommandId: userCommand.commandId,
        faceCommandIds: faceCommands.commandIds,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/enroll-user-with-photo-file', upload.single('image'), asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);

    if (!pin || !name || !password) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name y password validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Debes enviar image en multipart/form-data' });
    }

    const enrollment = enqueueAdmsPhotoEnrollment({
        pin,
        name,
        password,
        tempFilePath: req.file.path
    });

    logStore.info('adms.enroll-user-with-photo-file.enqueued', {
        pin,
        name,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedAs: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        warning: 'BIOPHOTO enviado; reconocimiento facial puede requerir BIODATA'
    });

    res.json({
        ok: true,
        pin,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedAs: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        warning: 'BIOPHOTO enviado; reconocimiento facial puede requerir BIODATA'
    });
}));

app.post('/adms/enroll-person', upload.single('image'), asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);

    if (!pin || !name || !password) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name y password validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Debes enviar image en multipart/form-data' });
    }

    const enrollment = enqueueAdmsPhotoEnrollment({
        pin,
        name,
        password,
        tempFilePath: req.file.path
    });
    persistAdmsPerson({
        pin,
        name,
        photo: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId
    });

    logStore.info('adms.enroll-person.enqueued', {
        pin,
        name,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedPhoto: enrollment.savedPhoto,
        imageSize: enrollment.imageSize
    });

    res.json({
        ok: true,
        pin,
        name,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedPhoto: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        message: 'Persona encolada para enrolamiento ADMS'
    });
}));

app.get('/adms/persons', asyncHandler(async (_req, res) => {
    res.json(readLatestAdmsPersons());
}));

app.get('/adms/persons/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    const person = readLatestAdmsPersonByPin(pin);
    if (!person) {
        return res.status(404).json({ ok: false, error: 'Persona no encontrada' });
    }

    res.json({
        ...person,
        attendance: readAttendanceEntries({ pin, limit: 10 })
    });
}));

app.post('/adms/persons/rebuild', asyncHandler(async (_req, res) => {
    const rebuilt = rebuildAdmsPersonsFromFiles();
    res.json({
        ok: true,
        rebuilt: rebuilt.length,
        persons: rebuilt
    });
}));

app.get('/usuarios', asyncHandler(async (_req, res) => {
    const [rows] = await db.query('SELECT * FROM usuarios');
    res.json(rows);
}));

app.get('/pendientes', asyncHandler(async (_req, res) => {
    const [rows] = await db.query("SELECT * FROM usuarios WHERE estado = 'pendiente'");
    res.json(rows);
}));

app.get('/activos', asyncHandler(async (_req, res) => {
    const [rows] = await db.query("SELECT * FROM usuarios WHERE estado = 'activo'");
    res.json(rows);
}));

app.get('/usuario/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    const [rows] = await db.query('SELECT * FROM usuarios WHERE pin = ?', [pin]);
    if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }

    res.json(rows[0]);
}));

app.get('/foto/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    const [rows] = await db.query('SELECT foto FROM usuarios WHERE pin = ?', [pin]);
    if (rows.length === 0 || !rows[0].foto) {
        return res.status(404).json({ ok: false, error: 'No encontrado' });
    }

    res.sendFile(path.join(uploadsDir, rows[0].foto));
}));

app.get('/health', (_req, res) => {
    res.json({
        estado: 'Servidor activo',
        bd: config.mysql.database,
        puerto: config.server.port,
        zk: {
            ip: config.zk.ip || null,
            port: config.zk.port,
            timeoutMs: config.zk.timeoutMs
        }
    });
});

app.post('/zk/connect', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/connect', () => zkTcpService.connect(resolveZkOptions(req)));
}));

app.get('/zk/test-connection', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/test-connection', () => zkTcpService.testConnection(resolveZkOptions(req)), 503);
}));

app.get('/zk/ping', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/ping', () => zkTcpService.ping(resolveZkOptions(req)), 503);
}));

app.get('/zk/device-info', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/device-info', () => zkTcpService.getDeviceInfo(resolveZkOptions(req)), 503);
}));

app.get('/zk/users', asyncHandler(async (req, res) => {
    const result = await zkTcpService.getUsers(resolveZkOptions(req));
    res.json(result);
}));

app.post('/zk/create-user', asyncHandler(async (req, res) => {
    const rawPassword = req.body.password;
    const payload = {
        ...resolveZkOptions(req),
        uid: normalizeUid(req.body.uid || req.body.pin),
        userId: normalizeUserId(req.body.userId || req.body.uid || req.body.pin),
        name: normalizeName(req.body.name || req.body.nombre),
        password: normalizePassword(rawPassword),
        role: parseInteger(req.body.role, 0),
        cardNo: req.body.cardNo ? String(req.body.cardNo).trim() : ''
    };

    if (!payload.uid || !payload.userId || !payload.name) {
        return res.status(400).json({
            ok: false,
            error: 'Debes enviar uid, userId o pin, y name'
        });
    }

    if (rawPassword !== undefined && payload.password === null) {
        return res.status(400).json({ ok: false, error: 'Password invalido. Usa 1-16 caracteres ASCII sin espacios.' });
    }

    const result = await zkTcpService.createUser(payload);
    res.status(201).json(result);
}));

app.post('/zk/update-user', asyncHandler(async (req, res) => {
    const payload = {
        ...resolveZkOptions(req),
        uid: normalizeUid(req.body.uid || req.body.pin),
        userId: normalizeUserId(req.body.userId || req.body.uid || req.body.pin),
        name: normalizeName(req.body.name || req.body.nombre),
        password: normalizePassword(req.body.password),
        role: parseInteger(req.body.role, 0),
        cardNo: req.body.cardNo ? String(req.body.cardNo).trim() : ''
    };

    if (!payload.uid || !payload.userId) {
        return res.status(400).json({
            ok: false,
            error: 'Debes enviar uid y/o userId'
        });
    }

    const result = await zkTcpService.updateUser(payload);
    res.json(result);
}));

app.delete('/zk/user/:uid', asyncHandler(async (req, res) => {
    const payload = {
        ...resolveZkOptions(req),
        uid: normalizeUid(req.params.uid),
        userId: normalizeUserId(req.query.userId)
    };

    if (!payload.uid) {
        return res.status(400).json({ ok: false, error: 'UID invalido' });
    }

    const result = await zkTcpService.deleteUser(payload);
    res.json(result);
}));

app.get('/zk/logs', (req, res) => {
    const limit = Math.min(parseInteger(req.query.limit, 50), 200);
    res.json({
        ok: true,
        total: limit,
        logs: logStore.getEntries(limit)
    });
});

app.use('/uploads', express.static(uploadsDir));

app.use((error, _req, res, _next) => {
    logStore.error('http.request.failed', {
        message: error.message,
        code: error.code || null
    });

    const statusCode = error.statusCode || error.status || 500;
    res.status(statusCode).json({
        ok: false,
        error: error.message || 'Error interno del servidor',
        code: error.code || 'INTERNAL_ERROR'
    });
});

app.listen(config.server.port, '0.0.0.0', () => {
    console.log(`Servidor ADMS + TCP ZKTeco escuchando en http://0.0.0.0:${config.server.port}`);
    console.log(`ADMS: http://TU_IP:${config.server.port}/iclock/cdata`);
});

function ensureDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
    }
}

function admsTrafficLogger(req, _res, next) {
    appendAdmsTrafficLog({
        timestamp: new Date().toISOString(),
        method: req.method,
        originalUrl: req.originalUrl,
        query: req.query,
        headers: {
            'user-agent': req.headers['user-agent'] || '',
            'content-type': req.headers['content-type'] || '',
            'content-length': req.headers['content-length'] || ''
        },
        ip: req.ip,
        body: getRawIclockBody(req)
    });

    next();
}

function appendAdmsTrafficLog(entry) {
    fs.appendFileSync(admsTrafficLogPath, `${JSON.stringify(entry)}\n`);
}

function appendAdmsCommandResultLog(entry) {
    fs.appendFileSync(admsCommandResultsLogPath, `${JSON.stringify(entry)}\n`);
}

function appendJsonLine(filePath, entry) {
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function readJsonLinesFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (_error) {
                return null;
            }
        })
        .filter(Boolean);
}

function persistAdmsPerson({ pin, name, photo, imageSize, userCommandId, biophotoCommandId }) {
    const now = new Date().toISOString();
    const previous = readLatestAdmsPersonByPin(pin);

    appendJsonLine(admsPersonsLogPath, {
        pin,
        name,
        photo,
        imageSize,
        userCommandId,
        biophotoCommandId,
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now
    });
}

function readLatestAdmsPersons() {
    const latestByPin = new Map();
    for (const entry of readJsonLinesFile(admsPersonsLogPath)) {
        if (!entry || !entry.pin) {
            continue;
        }

        latestByPin.set(entry.pin, {
            pin: entry.pin,
            name: entry.name,
            photo: entry.photo,
            imageSize: entry.imageSize,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        });
    }

    return Array.from(latestByPin.values())
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function readLatestAdmsPersonByPin(pin) {
    return readLatestAdmsPersons().find(entry => entry.pin === pin) || null;
}

function rebuildAdmsPersonsFromFiles() {
    const previousByPin = new Map(readLatestAdmsPersons().map(entry => [entry.pin, entry]));
    const rebuilt = fs.readdirSync(facesUploadsDir)
        .map(fileName => {
            const match = fileName.match(/^(\d+)\.jpg$/i);
            if (!match) {
                return null;
            }

            const pin = match[1];
            const absolutePath = path.join(facesUploadsDir, fileName);
            const stats = fs.statSync(absolutePath);
            const previous = previousByPin.get(pin);
            const timestamp = resolveFileTimestamp(stats);

            return {
                pin,
                name: previous?.name || `PIN_${pin}`,
                photo: `uploads/faces/${fileName}`,
                imageSize: stats.size,
                userCommandId: previous?.userCommandId || null,
                biophotoCommandId: previous?.biophotoCommandId || null,
                createdAt: previous?.createdAt || timestamp,
                updatedAt: timestamp
            };
        })
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const fileContent = rebuilt.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(admsPersonsLogPath, fileContent ? `${fileContent}\n` : '');

    return rebuilt.map(entry => ({
        pin: entry.pin,
        name: entry.name,
        photo: entry.photo,
        imageSize: entry.imageSize,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
    }));
}

function resolveFileTimestamp(stats) {
    const candidate = stats.birthtime instanceof Date && !Number.isNaN(stats.birthtime.getTime())
        ? stats.birthtime
        : stats.mtime;
    return candidate instanceof Date && !Number.isNaN(candidate.getTime())
        ? candidate.toISOString()
        : new Date().toISOString();
}

function normalizeAdmsQueueField(value, maxLength, useNameSanitizer) {
    const baseValue = useNameSanitizer ? normalizeAdmsCommandName(value) : String(value || '').replace(/[^\x20-\x7E]/g, '');
    return baseValue.replace(/[\t\r\n=]/g, '').slice(0, maxLength);
}

function enqueueAdmsUserinfoCommand({ pin, name, password, verify }) {
    const commandId = admsCommandId++;
    const command = `C:${commandId}:DATA UPDATE USERINFO PIN=${pin}\tName=${name}\tPri=0\tPasswd=${password}\tCard=\tGrp=1\tTZ=0000000100000000\tVerify=${verify}\tViceCard=\tStartDatetime=0\tEndDatetime=0`;
    encolarComando(command);

    return {
        commandId,
        command
    };
}

function enqueueAdmsPhotoEnrollment({ pin, name, password, tempFilePath }) {
    const savedFileName = `${pin}.jpg`;
    const savedFilePath = path.join(facesUploadsDir, savedFileName);
    fs.renameSync(tempFilePath, savedFilePath);

    const imageBuffer = fs.readFileSync(savedFilePath);
    const imageBase64 = imageBuffer.toString('base64');
    const imageSize = imageBuffer.length;
    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name,
        password,
        verify: 0
    });

    const biophotoCommandId = admsCommandId++;
    const biophotoCommand = `C:${biophotoCommandId}:DATA UPDATE BIOPHOTO PIN=${pin}\tNo=0\tIndex=0\tFileName=${pin}.jpg\tType=9\tSize=${imageSize}\tContent=${imageBase64}`;
    encolarComando(biophotoCommand);

    return {
        userCommandId: userCommand.commandId,
        biophotoCommandId,
        savedPhoto: `uploads/faces/${savedFileName}`,
        imageSize
    };
}

function enqueueAdmsFaceCopyCommands(sourcePin, targetPin) {
    const biophotoEntries = readJsonLinesFile(admsBiophotoLogPath);
    const biodataEntries = readJsonLinesFile(admsBiodataLogPath);
    const latestBiophoto = findLatestAdmsEntry(biophotoEntries, sourcePin, '9');
    const latestBiodata = findLatestAdmsEntry(biodataEntries, sourcePin, '9');

    if (!latestBiophoto) {
        const error = new Error(`No existe BIOPHOTO Type=9 para sourcePin ${sourcePin}`);
        error.statusCode = 404;
        throw error;
    }

    if (!latestBiodata) {
        const error = new Error(`No existe BIODATA Type=9 para sourcePin ${sourcePin}`);
        error.statusCode = 404;
        throw error;
    }

    const biophotoFileName = String(latestBiophoto.savedAs || `${latestBiophoto.pin}-${latestBiophoto.type}-${latestBiophoto.index}.jpg`);
    const biophotoFilePath = path.join(biophotosDir, biophotoFileName);
    if (!fs.existsSync(biophotoFilePath)) {
        const error = new Error(`No existe el archivo BIOPHOTO ${biophotoFileName}`);
        error.statusCode = 404;
        throw error;
    }

    const biophotoBase64 = fs.readFileSync(biophotoFilePath).toString('base64');
    const biophotoCommandId = admsCommandId++;
    const biodataCommandId = admsCommandId++;
    const biophotoCommand = `C:${biophotoCommandId}:DATA UPDATE BIOPHOTO PIN=${targetPin}\tNo=${latestBiophoto.no}\tIndex=${latestBiophoto.index}\tFileName=${targetPin}.jpg\tType=9\tSize=${latestBiophoto.size}\tContent=${biophotoBase64}`;
    const biodataCommand = `C:${biodataCommandId}:DATA UPDATE BIODATA Pin=${targetPin}\tNo=${latestBiodata.no}\tIndex=${latestBiodata.index}\tValid=1\tDuress=0\tType=9\tMajorVer=35\tMinorVer=4\tFormat=0\tTmp=${latestBiodata.tmp}`;

    encolarComando(biophotoCommand);
    encolarComando(biodataCommand);

    return {
        commandIds: {
            biophoto: biophotoCommandId,
            biodata: biodataCommandId
        },
        summary: {
            biophoto: {
                no: latestBiophoto.no,
                index: latestBiophoto.index,
                type: latestBiophoto.type,
                size: latestBiophoto.size,
                fileName: `${targetPin}.jpg`
            },
            biodata: {
                no: latestBiodata.no,
                index: latestBiodata.index,
                type: latestBiodata.type,
                majorVer: latestBiodata.majorVer,
                minorVer: latestBiodata.minorVer,
                format: latestBiodata.format
            }
        }
    };
}

function findLatestAdmsEntry(entries, pin, type) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (String(entry.pin || '') === String(pin) && String(entry.type || '') === String(type)) {
            return entry;
        }
    }

    return null;
}

function readAttendanceEntries(filters = {}) {
    const pin = String(filters.pin || '').trim();
    const from = normalizeDateFilter(filters.from);
    const to = normalizeDateFilter(filters.to);
    const limit = normalizeAttendanceLimit(filters.limit);

    let entries = readJsonLinesFile(admsAttlogLogPath)
        .filter(entry => !pin || entry.pin === pin)
        .filter(entry => {
            const entryDate = String(entry.timestamp || '').slice(0, 10);
            if (from && entryDate < from) {
                return false;
            }

            if (to && entryDate > to) {
                return false;
            }

            return true;
        })
        .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));

    if (limit > 0) {
        entries = entries.slice(0, limit);
    }

    return entries;
}

function buildAttendanceSummary(pin, date) {
    const checks = readAttendanceEntries({ pin, from: date, to: date })
        .slice()
        .reverse()
        .map(entry => ({
            timestamp: entry.timestamp,
            verifyMode: entry.verifyMode,
            sn: entry.sn
        }));

    return {
        pin,
        date,
        firstCheck: checks.length > 0 ? checks[0].timestamp : null,
        lastCheck: checks.length > 0 ? checks[checks.length - 1].timestamp : null,
        totalChecks: checks.length,
        checks
    };
}

function normalizeDateFilter(value) {
    const raw = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function normalizeAttendanceLimit(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.min(parsed, 1000);
}

function getRawIclockBody(req) {
    return typeof req.body === 'string' ? req.body : '';
}

function sendPlainText(res, body) {
    res.type('text/plain');
    res.send(body);
}

function flushPendingCommands() {
    if (comandosPendientes.length === 0) {
        return 'OK';
    }

    const response = comandosPendientes.join('\r\n');
    logStore.info('adms.commands.flushed', {
        total: comandosPendientes.length
    });
    comandosPendientes = [];
    return response;
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
}

function resolveBaseUrl(value) {
    const url = new URL(String(value || 'http://localhost:8098'));
    return `${url.protocol}//${url.host}`;
}

function normalizePin(value) {
    const raw = String(value || '').trim();
    return /^\d{1,20}$/.test(raw) ? raw : '';
}

function normalizeUid(value) {
    return normalizePin(value);
}

function normalizeUserId(value) {
    const raw = String(value || '').trim();
    return /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : '';
}

function normalizeName(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 64) {
        return '';
    }

    const sanitized = raw.replace(/[^\p{L}\p{N}\s._-]/gu, '').trim();
    return sanitized.length >= 2 ? sanitized : '';
}

function normalizeAdmsCommandName(value) {
    const asciiName = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const cleaned = asciiName
        .replace(/[^A-Za-z0-9 _-]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 24);

    return cleaned.length >= 2 ? cleaned : '';
}

function parseAdmsDevicecmdResult(req) {
    const rawBody = getRawIclockBody(req);
    const bodyFields = parseAdmsFieldMap(rawBody);
    const queryFields = normalizeFieldMap(req.query);

    return {
        sn: firstNonEmpty(bodyFields.SN, queryFields.SN),
        id: firstNonEmpty(bodyFields.ID, queryFields.ID),
        returnValue: firstNonEmpty(bodyFields.Return, queryFields.Return),
        cmd: firstNonEmpty(bodyFields.CMD, queryFields.CMD),
        rawBody
    };
}

function parseAdmsFieldMap(text) {
    const params = new URLSearchParams(String(text || '').trim());
    const values = {};

    for (const [key, value] of params.entries()) {
        values[key] = value;
    }

    return values;
}

function normalizeFieldMap(value) {
    const entries = Object.entries(value || {});
    const normalized = {};

    for (const [key, raw] of entries) {
        normalized[key] = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
    }

    return normalized;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value !== '') {
            return value;
        }
    }

    return '';
}

function buildZkbioUserFormEntries({ pin, name, deptId, personLevelId, personAreaId, browserToken }) {
    const now = new Date();
    const currentDay = formatLocalDate(now);
    const finalDeptId = String(deptId || '').trim();
    const finalPersonLevelId = String(personLevelId || '').trim();
    const finalPersonAreaId = normalizeCommaSeparatedIds(process.env.ZKBIO_PERSON_AREA_ID || personAreaId || '');

    return [
        ['save', ''],
        ['id', ''],
        ['personIdPhoto', ''],
        ['idCardPhysicalNo', ''],
        ['idCard', ''],
        ['bioTemplateJson', ''],
        ['leaveId', ''],
        ['moduleAuth', 'acc,att,'],
        ['existsMobileUser', ''],
        ['cropPhotoBase64', ''],
        ['cropPhotoDel', 'false'],
        ['enabledCredential', ''],
        ['pin', pin],
        ['deptId', finalDeptId],
        ['deptId_new_value', 'false'],
        ['name', name],
        ['lastName', ''],
        ['gender', ''],
        ['gender_new_value', 'false'],
        ['mobilePhone', ''],
        ['sendSMS', 'false'],
        ['certType', ''],
        ['certType_new_value', 'false'],
        ['regnizeIdreader', ''],
        ['certNumber', ''],
        ['birthday', ''],
        ['mail', ''],
        ['isSendMail', 'false'],
        ['hireDate', ''],
        ['positionId', ''],
        ['positionId_new_value', 'false'],
        ['personPwd', ''],
        ['cardNos', ''],
        ['multiCards_0', ''],
        ['acmsCardNum', '0'],
        ['acmsMasterCard', '0'],
        ['personPhoto', ''],
        ['acc.personLevelIds', finalPersonLevelId],
        ['accPersonLevelFilterIds', ''],
        [PERSON_LEVEL_DYNAMIC_INPUT, finalPersonLevelId],
        ['acc.superAuth', '0'],
        ['acc.superAuth_new_value', 'false'],
        ['acc.privilege', '0'],
        ['acc.privilege_new_value', 'false'],
        ['acc.delayPassage', 'false'],
        ['acc.disabled', 'false'],
        ['acc.isSetValidTime', 'false'],
        ['acc.startTime', `${currentDay} 00:00:00`],
        ['acc.endTime', `${currentDay} 23:59:59`],
        ['att.personAreas', finalPersonAreaId],
        ['att.isAttendance', 'true'],
        ['att.isAttendance_new_value', 'false'],
        ['att.perDevAuth', '0'],
        ['att.perDevAuth_new_value', 'false'],
        ['att.verifyMode', ''],
        ['att.verifyMode_new_value', 'false'],
        ['attrValue1', ''],
        ['attrValue1_new_value', 'false'],
        ['attrValue2', ''],
        ['attrValue2_new_value', 'false'],
        ['attrValue3', ''],
        ['attrValue5', ''],
        ['attrValue7', ''],
        ['attrValue8', ''],
        ['attrValue9', ''],
        ['attrValue10', ''],
        ['attrValue11', ''],
        ['attrValue12', ''],
        ['cardNos', ''],
        ['multiCards_1', ''],
        ['logMethod', 'add'],
        ['browserToken', browserToken]
    ];
}

function normalizeCommaSeparatedIds(value) {
    const items = String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    return items.length > 0 ? `${items.join(',')},` : '';
}

function formatLocalDate(value) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function normalizePassword(value) {
    if (value === undefined || value === null || value === '') {
        return '';
    }

    const raw = String(value);
    return /^[\x21-\x7E]{1,16}$/.test(raw) ? raw : null;
}

async function handleZkEndpoint(req, res, endpoint, action, failureStatus = 502) {
    const startedAt = process.hrtime.bigint();
    const ip = String((req.method === 'GET' ? req.query.ip : req.body.ip) || config.zk.ip || '').trim() || null;

    try {
        const result = await action();
        const durationMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
        logStore.info('zk.endpoint.result', {
            endpoint,
            ip,
            durationMs,
            result: result.ok === false ? 'error' : 'success'
        });
        res.status(result.ok === false ? failureStatus : 200).json(result);
    } catch (error) {
        const durationMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
        logStore.warn('zk.endpoint.result', {
            endpoint,
            ip,
            durationMs,
            result: 'error',
            code: error.code || null
        });
        res.status(error.statusCode || failureStatus).json({
            ok: false,
            endpoint,
            ip,
            durationMs,
            error: error.message || 'Error de comunicacion con ZKTeco',
            code: error.code || 'ZK_ENDPOINT_FAILED'
        });
    }
}

function traducirMetodo(codigo) {
    const metodos = {
        '0': 'Huella',
        '1': 'Huella',
        '2': 'Tarjeta',
        '15': 'Reconocimiento Facial'
    };
    return metodos[codigo] || 'Desconocido';
}

function procesarRegistros(body) {
    if (!body || typeof body !== 'string') {
        return [];
    }

    return body
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /^\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\d+/.test(linea))
        .map(linea => {
            const match = linea.match(/^(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)(?:\s+(\d+))?(?:\s+([^\s]+))?/);
            if (!match) {
                return null;
            }

            return {
                pin: match[1],
                fecha: `${match[2]} ${match[3]}`,
                timestamp: `${match[2]} ${match[3]}`,
                metodo: match[4],
                metodoTexto: traducirMetodo(match[4]),
                verifyStatus: match[4],
                verifyMode: match[5] || '',
                workCode: match[6] || '',
                rawLine: linea
            };
        })
        .filter(Boolean);
}

function persistirAttlog(registros, req) {
    if (!Array.isArray(registros) || registros.length === 0) {
        return;
    }

    const sn = String(req.query.SN || req.query.sn || '').trim();
    const receivedAt = new Date().toISOString();

    for (const registro of registros) {
        appendJsonLine(admsAttlogLogPath, {
            pin: registro.pin,
            timestamp: registro.timestamp,
            verifyStatus: registro.verifyStatus,
            verifyMode: registro.verifyMode,
            workCode: registro.workCode,
            rawLine: registro.rawLine,
            sn,
            receivedAt
        });
    }
}

function encolarComando(cmd) {
    if (!comandosPendientes.includes(cmd)) {
        comandosPendientes.push(cmd);
    }
}

async function procesarMensajeUser(body) {
    const pinMatch = body.match(/USER\s+PIN=(\d+)/i);
    const nameMatch = body.match(/Name=([^\r\n]+)/i);

    if (!pinMatch) {
        return;
    }

    const pin = pinMatch[1];
    const nombre = normalizeName(nameMatch ? nameMatch[1].trim() : `Usuario_${pin}`) || `Usuario_${pin}`;

    await db.query(
        `INSERT INTO usuarios (pin, nombre) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
        [pin, nombre]
    );

    logStore.info('adms.user.synced', {
        pin,
        nombre
    });
}

async function procesarBiodata(body) {
    const biodataLines = body
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /BIODATA/i.test(linea) && /Pin=\d+/i.test(linea) && /Tmp=/i.test(linea));

    for (const biodataLine of biodataLines) {
        const biodataEntry = parseBiodataLine(biodataLine);
        if (biodataEntry) {
            appendJsonLine(admsBiodataLogPath, {
                timestamp: new Date().toISOString(),
                ...biodataEntry
            });
        }
    }

    const biodataLine = biodataLines[0];

    if (!biodataLine) {
        return;
    }

    const pinMatch = biodataLine.match(/Pin=(\d+)/i);
    const tmpIndex = biodataLine.indexOf('Tmp=');

    if (!pinMatch || tmpIndex === -1) {
        logStore.warn('adms.biodata.invalid', { line: biodataLine });
        return;
    }

    const pin = pinMatch[1];
    const templateRaw = biodataLine.slice(tmpIndex + 4).trim();

    if (templateRaw.length < 20) {
        logStore.warn('adms.biodata.short-template', {
            pin,
            length: templateRaw.length
        });
        return;
    }

    const [rows] = await db.query('SELECT template FROM usuarios WHERE pin = ?', [pin]);

    if (rows.length === 0) {
        await db.query(
            `INSERT INTO usuarios (pin, nombre, template, estado)
             VALUES (?, ?, ?, 'activo')`,
            [pin, `Usuario_${pin}`, templateRaw]
        );

        logStore.info('adms.biodata.user-created', {
            pin,
            templateLength: templateRaw.length
        });
        return;
    }

    if (rows[0].template) {
        logStore.warn('adms.biodata.skipped-existing-template', { pin });
        return;
    }

    await db.query(
        `UPDATE usuarios SET template = ?, estado = 'activo' WHERE pin = ?`,
        [templateRaw, pin]
    );

    logStore.info('adms.biodata.saved', {
        pin,
        templateLength: templateRaw.length
    });
}

async function procesarBiophotos(body) {
    const biophotoLines = body
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /BIOPHOTO/i.test(linea) && /PIN=\d+/i.test(linea) && /Content=/i.test(linea));

    for (const biophotoLine of biophotoLines) {
        const biophotoEntry = parseBiophotoLine(biophotoLine);
        if (!biophotoEntry) {
            continue;
        }

        const fileName = `${biophotoEntry.pin}-${biophotoEntry.type}-${biophotoEntry.index}.jpg`;
        const filePath = path.join(biophotosDir, fileName);

        fs.writeFileSync(filePath, Buffer.from(biophotoEntry.content, 'base64'));

        appendJsonLine(admsBiophotoLogPath, {
            timestamp: new Date().toISOString(),
            pin: biophotoEntry.pin,
            no: biophotoEntry.no,
            index: biophotoEntry.index,
            fileName: biophotoEntry.fileName,
            type: biophotoEntry.type,
            size: biophotoEntry.size,
            savedAs: fileName
        });
    }
}

function parseBiodataLine(line) {
    if (!line) {
        return null;
    }

    const tmpIndex = line.indexOf('Tmp=');
    if (tmpIndex === -1) {
        return null;
    }

    const metadata = line.slice(0, tmpIndex).trim();
    const tmp = line.slice(tmpIndex + 4).trim();

    return {
        pin: extractField(metadata, 'Pin'),
        no: extractField(metadata, 'No'),
        index: extractField(metadata, 'Index'),
        valid: extractField(metadata, 'Valid'),
        duress: extractField(metadata, 'Duress'),
        type: extractField(metadata, 'Type'),
        majorVer: extractField(metadata, 'MajorVer'),
        minorVer: extractField(metadata, 'MinorVer'),
        format: extractField(metadata, 'Format'),
        tmp
    };
}

function parseBiophotoLine(line) {
    if (!line) {
        return null;
    }

    const contentIndex = line.indexOf('Content=');
    if (contentIndex === -1) {
        return null;
    }

    const metadata = line.slice(0, contentIndex).trim();
    const content = line.slice(contentIndex + 8).trim();

    return {
        pin: extractField(metadata, 'PIN'),
        no: extractField(metadata, 'No'),
        index: extractField(metadata, 'Index'),
        fileName: extractField(metadata, 'FileName'),
        type: extractField(metadata, 'Type'),
        size: extractField(metadata, 'Size'),
        content
    };
}

function extractField(text, fieldName) {
    const match = String(text || '').match(new RegExp(`${fieldName}=([^\\s]+)`, 'i'));
    return match ? match[1] : '';
}

function resolveZkOptions(req) {
    const source = req.method === 'GET' ? req.query : req.body;
    return {
        ip: String(source.ip || config.zk.ip || '').trim(),
        port: parseInteger(source.port, config.zk.port),
        timeoutMs: parseInteger(source.timeoutMs, config.zk.timeoutMs)
    };
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}
