const path = require('path');
const { createZkbioAccessHttpService } = require('../services/zkbioAccessHttpService');

async function main() {
    const baseUrl = resolveBaseUrl(process.env.ZKBIO_URL || 'http://localhost:8098');
    const username = process.env.ZKBIO_USER || process.env.ZKBIO_USERNAME || 'admin';
    const password = process.env.ZKBIO_PASS || process.env.ZKBIO_PASSWORD || '';
    const browserToken = process.env.ZKBIO_BROWSER_TOKEN || '';
    const photoPath = path.resolve(process.env.ZKBIO_USER_PHOTO || 'uploads/1776357318491-189953989.jpeg');
    const pin = '12444';
    const deptId = process.env.ZKBIO_DEPT_ID || '402882e19db1b4d7019db1b5b9180004';
    const personLevelId = process.env.ZKBIO_PERSON_LEVEL_ID || '402882e19db1b4d7019db1b5ed170431';
    const personAreaId = process.env.ZKBIO_PERSON_AREA_ID || '402882e19db1b4d7019db1b5b8e50003';

    const service = createZkbioAccessHttpService({ baseUrl });

    await service.login(username, password);

    const result = await service.createUserWithPhoto({
        pin,
        personPhoto: photoPath,
        formEntries: [
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
            ['deptId', deptId],
            ['deptId_new_value', 'false'],
            ['name', 'dieg4o'],
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
            ['acc.personLevelIds', personLevelId],
            ['accPersonLevelFilterIds', ''],
            ['input_59cf4b9f7f0b4510be1a7b76873f932f', personLevelId],
            ['acc.superAuth', '0'],
            ['acc.superAuth_new_value', 'false'],
            ['acc.privilege', '0'],
            ['acc.privilege_new_value', 'false'],
            ['acc.delayPassage', 'false'],
            ['acc.disabled', 'false'],
            ['acc.isSetValidTime', 'false'],
            ['acc.startTime', '2026-04-22 00:00:00'],
            ['acc.endTime', '2026-04-22 23:59:59'],
            ['att.personAreas', personAreaId],
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
        ]
    });

    console.log('success:', result.ok === true);
    console.log('ret:', result.data?.ret ?? '');
    console.log('msg:', result.data?.msg ?? '');
    console.log('status:', result.data?.status ?? result.status ?? '');
    console.log('rawBody:', result.rawBody || '');
}

function resolveBaseUrl(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
}

main().catch(error => {
    console.error('success:', false);
    console.error('ret:', error.details?.parsedBody?.ret ?? '');
    console.error('msg:', error.details?.parsedBody?.msg ?? '');
    console.error('status:', error.statusCode || '');
    console.error('error:', JSON.stringify({
        message: error.message,
        code: error.code || null,
        statusCode: error.statusCode || null,
        details: error.details || null
    }));
    process.exit(1);
});