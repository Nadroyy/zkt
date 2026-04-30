const { createZkbioAccessHttpService } = require('../services/zkbioAccessHttpService');

async function main() {
    const baseUrl = resolveBaseUrl(process.env.ZKBIO_URL || 'http://localhost:8098');
    const username = process.env.ZKBIO_USER || process.env.ZKBIO_USERNAME || 'admin';
    const password = process.env.ZKBIO_PASS || process.env.ZKBIO_PASSWORD || '';

    const service = createZkbioAccessHttpService({ baseUrl });
    const result = await service.login(username, password);

    console.log('loginSuccess:', result.ok === true);
    console.log('session:', result.sessionCookie || '');
    console.log('browserToken:', result.browserToken || '');
}

function resolveBaseUrl(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
}

main().catch(error => {
    console.error('loginSuccess:', false);
    console.error('session:', '');
    console.error('browserToken:', '');
    console.error('error:', error.message);
    process.exit(1);
});
