const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts', 'zkbioaccess');
const SCREENSHOTS_DIR = path.join(ARTIFACTS_DIR, 'screenshots');

const config = {
    url: process.env.ZKBIO_URL || 'http://localhost:8098/bioLogin.do',
    username: process.env.ZKBIO_USER || process.env.ZKBIO_USERNAME || 'admin',
    password: process.env.ZKBIO_PASS || process.env.ZKBIO_PASSWORD || ''
};

const TRAFFIC_KEYWORDS = [
    'admsDevice',
    'device',
    'cmd',
    'command',
    'sync',
    'issue',
    'authorize',
    'download',
    'upload'
];
const BODY_PREVIEW_LIMIT = 3000;

async function main() {
    ensureDirectory(SCREENSHOTS_DIR);

    log('Iniciando navegador...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    try {
        validateConfig();

        log(`Abriendo ${config.url}`);
        await page.goto(config.url, { waitUntil: 'domcontentloaded' });

        await login(page);
        installSyncTrafficLogger(page);

        console.log('PAUSA: haz clic manualmente en los botones de sincronizacion y luego presiona ENTER aqui...');
        await new Promise(resolve => {
            process.stdin.resume();
            process.stdin.once('data', () => resolve());
        });
    } catch (error) {
        const screenshotPath = await takeErrorScreenshot(page);
        console.error(`[zkbio] Error: ${error.message}`);
        if (screenshotPath) {
            console.error(`[zkbio] Screenshot: ${screenshotPath}`);
        }
        process.exitCode = 1;
    } finally {
        await context.close();
        await browser.close();
    }
}

async function login(page) {
    log('Esperando formulario de login...');
    await page.waitForSelector('input[name="username"], input[name="password"], input[type="password"]', {
        state: 'visible',
        timeout: 20000
    });

    const userInput = await firstVisible([
        page.locator('input[name="username"]').first(),
        page.locator('input[name="userName"]').first(),
        page.locator('input[placeholder*="User" i]').first(),
        page.locator('input[placeholder*="Usuario" i]').first(),
        page.getByLabel(/user\s*name|username|usuario/i).first(),
        page.locator('input[type="text"]').first()
    ]);

    const passwordInput = await firstVisible([
        page.locator('input[name="password"]').first(),
        page.locator('input[placeholder*="Password" i]').first(),
        page.locator('input[placeholder*="Contrase" i]').first(),
        page.getByLabel(/password|contrasena|contrase.a/i).first(),
        page.locator('input[type="password"]').first()
    ]);

    log('Llenando usuario...');
    await userInput.fill(config.username);

    log('Llenando password...');
    await passwordInput.fill(config.password);

    const loginButton = await firstVisible([
        page.getByRole('button', { name: /login|iniciar|sign in/i }).first(),
        page.locator('button[type="submit"]').first(),
        page.locator('input[type="submit"]').first(),
        page.locator('button').filter({ hasText: /login|iniciar|sign in/i }).first()
    ]);

    log('Haciendo click en Login...');
    await Promise.all([
        page.waitForNavigation({
            url: /\/main\.do(?:\?|$)/i,
            waitUntil: 'domcontentloaded',
            timeout: 20000
        }),
        loginButton.click()
    ]);

    log(`Login exitoso. URL actual: ${page.url()}`);
}

function installSyncTrafficLogger(page) {
    log(`Grabando trafico que contenga: ${TRAFFIC_KEYWORDS.join(', ')}`);

    page.on('frameattached', frame => {
        console.log('FRAME ATTACHED:', frame.url());
    });

    page.on('framenavigated', frame => {
        const url = frame.url();
        if (url.includes('do') || url.includes('device') || url.includes('command')) {
            console.log('===== IFRAME NAVIGATION =====');
            console.log('URL:', url);
        }
    });

    page.on('request', req => {
        const postData = req.postData();

        if (req.method() === 'POST') {
            console.log('===== POST REQUEST =====');
            console.log('URL:', req.url());
            console.log('POST_DATA:', postData);
            return;
        }

        if (!matchesTrackedTraffic(req.url(), postData)) {
            return;
        }

        console.log('===== SYNC REQUEST =====');
        console.log('METHOD:', req.method());
        console.log('URL:', req.url());
        if (postData) {
            console.log('POST_DATA:', postData);
        }
    });

    page.on('response', async res => {
        const req = res.request();
        const postData = req.postData();

        if (!matchesTrackedTraffic(res.url(), postData)) {
            return;
        }

        console.log('===== SYNC RESPONSE =====');
        console.log('METHOD:', req.method());
        console.log('URL:', res.url());
        if (postData) {
            console.log('POST_DATA:', postData);
        }
        console.log('STATUS:', res.status());

        try {
            const body = await res.text();
            console.log('BODY_PREVIEW:', previewBody(body));
        } catch (error) {
            console.log('BODY_READ_ERROR:', error.message);
        }
    });
}

function matchesTrackedTraffic(url, postData = '') {
    const haystack = `${url || ''}\n${postData || ''}`.toLowerCase();
    return TRAFFIC_KEYWORDS.some(keyword => haystack.includes(keyword.toLowerCase()));
}

function previewBody(body) {
    const text = String(body || '');
    if (text.length <= BODY_PREVIEW_LIMIT) {
        return text;
    }

    return `${text.slice(0, BODY_PREVIEW_LIMIT)}... [truncated ${text.length - BODY_PREVIEW_LIMIT} chars]`;
}

async function firstVisible(locators, options = {}) {
    const timeout = options.timeout || 8000;

    for (const locator of locators) {
        try {
            await locator.waitFor({ state: 'visible', timeout });
            return locator;
        } catch (_error) {
            continue;
        }
    }

    throw new Error('No encontre un elemento visible para continuar con el login.');
}

async function takeErrorScreenshot(page) {
    try {
        const fileName = `error-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const filePath = path.join(SCREENSHOTS_DIR, fileName);
        await page.screenshot({ path: filePath, fullPage: true });
        return filePath;
    } catch (_error) {
        return null;
    }
}

function validateConfig() {
    if (!config.password) {
        throw new Error('Falta ZKBIO_PASS o ZKBIO_PASSWORD en el entorno.');
    }
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function log(message) {
    console.log(`[zkbio] ${message}`);
}

main().catch(error => {
    console.error(`[zkbio] Error fatal: ${error.message}`);
    process.exit(1);
});
