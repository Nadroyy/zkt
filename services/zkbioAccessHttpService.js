const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const PERSON_LEVEL_DYNAMIC_INPUT = 'input_81f0fcc729e7479a8f16f00e2a959c13';
const LEGACY_PERSON_LEVEL_INPUTS = [
    'input_59cf4b9f7f0b4510be1a7b76873f932f',
    'input_8b2d06e939784f1da885b9248ab4da84'
];

function createZkbioAccessHttpService({ baseUrl, logStore } = {}) {
    const client = axios.create({
        baseURL: String(baseUrl || '').replace(/\/+$/, ''),
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400
    });

    const state = {
        sessionCookie: '',
        preSessionCookie: '',
        browserToken: ''
    };

    const api = {
        async prepareLoginContext() {
            const browserToken = String(process.env.ZKBIO_BROWSER_TOKEN || state.browserToken || '').trim();

            const bioLoginResponse = await client.get('/bioLogin.do', {
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                headers: buildBrowserHeaders({
                    sessionCookie: state.preSessionCookie,
                    browserToken,
                    referer: 'http://localhost:8098/bioLogin.do',
                    origin: 'http://localhost:8098'
                })
            });

            log('info', 'zkbio.http.step', {
                step: 'bioLogin',
                status: bioLoginResponse.status
            });

            if (isRedirectToBioLogin(bioLoginResponse)) {
                throw buildStepRedirectError('bioLogin', bioLoginResponse);
            }

            const preSessionCookie = extractSessionCookie(bioLoginResponse.headers['set-cookie']) || state.preSessionCookie;
            state.preSessionCookie = preSessionCookie;

            const fingerResponse = await client.post('/login.do?getFingerServiceConn', '', {
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                headers: buildBrowserHeaders({
                    sessionCookie: state.preSessionCookie,
                    browserToken,
                    referer: 'http://localhost:8098/bioLogin.do',
                    origin: 'http://localhost:8098',
                    requestedWith: 'XMLHttpRequest'
                })
            });

            log('info', 'zkbio.http.step', {
                step: 'getFingerServiceConn',
                status: fingerResponse.status
            });

            if (isRedirectToBioLogin(fingerResponse)) {
                throw buildStepRedirectError('getFingerServiceConn', fingerResponse);
            }

            return {
                ok: true,
                preSessionCookie: state.preSessionCookie
            };
        },

        async prepareCreateUserContext() {
            if (!state.sessionCookie) {
                const error = new Error('Debes ejecutar login() antes de prepareCreateUserContext()');
                error.code = 'ZKBIO_LOGIN_REQUIRED';
                error.statusCode = 401;
                throw error;
            }

            const browserToken = String(state.browserToken || process.env.ZKBIO_BROWSER_TOKEN || '').trim();
            const steps = [
                {
                    name: 'mainHomePers',
                    method: 'get',
                    url: '/main.do?home&selectSysCode=Pers',
                    referer: 'http://localhost:8098/bioLogin.do',
                    origin: 'http://localhost:8098'
                },
                {
                    name: 'persPersonEdit',
                    method: 'get',
                    url: '/persPerson.do?edit&deptId=&deptName=',
                    referer: 'http://localhost:8098/main.do?home&selectSysCode=Pers',
                    origin: 'http://localhost:8098'
                }
            ];

            for (const step of steps) {
                const response = await client.request({
                    method: step.method,
                    url: step.url,
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: buildBrowserHeaders({
                        sessionCookie: state.sessionCookie,
                        browserToken,
                        referer: step.referer,
                        origin: step.origin
                    })
                });

                log('info', 'zkbio.http.step', {
                    step: step.name,
                    status: response.status
                });

                if (isRedirectToBioLogin(response)) {
                    throw buildStepRedirectError(step.name, response);
                }
            }

            return { ok: true };
        },

        async getDepartments() {
            if (!state.sessionCookie) {
                const error = new Error('Debes ejecutar login() antes de getDepartments()');
                error.code = 'ZKBIO_LOGIN_REQUIRED';
                error.statusCode = 401;
                throw error;
            }

            const browserToken = String(state.browserToken || process.env.ZKBIO_BROWSER_TOKEN || '').trim();
            const uid = Date.now();
            const params = {
                dynaTree: 'true',
                showPersonCount: 'true',
                uid: String(uid),
                id: '0',
                [`dhxr${uid}`]: '1'
            };

            const response = await client.get('/authDepartment.do', {
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                params,
                headers: buildBrowserHeaders({
                    sessionCookie: state.sessionCookie,
                    browserToken,
                    referer: 'http://localhost:8098/persPerson.do?edit&deptId=&deptName=',
                    requestedWith: 'XMLHttpRequest'
                })
            });

            log('info', 'zkbio.http.step', {
                step: 'authDepartment',
                status: response.status,
                params
            });

            if (isRedirectToBioLogin(response)) {
                throw buildStepRedirectError('authDepartment', response);
            }

            const bodyText = typeof response.data === 'string' ? response.data : String(response.data || '');
            if (!/<tree\b/i.test(bodyText)) {
                log('warn', 'zkbio.http.departments.invalid-body', {
                    params,
                    preview: bodyText.slice(0, 300)
                });

                const error = new Error('authDepartment.do no devolvio el arbol XML esperado');
                error.code = 'ZKBIO_DEPARTMENTS_TREE_NOT_RETURNED';
                error.statusCode = 502;
                error.details = {
                    params,
                    preview: bodyText.slice(0, 300)
                };
                throw error;
            }

            const departments = parseDepartmentsXml(response.data);
            log('info', 'zkbio.http.departments.found', {
                total: departments.length,
                departments
            });

            return departments;
        },

        async getPersonLevels(deptId) {
            if (!state.sessionCookie) {
                const error = new Error('Debes ejecutar login() antes de getPersonLevels()');
                error.code = 'ZKBIO_LOGIN_REQUIRED';
                error.statusCode = 401;
                throw error;
            }

            const browserToken = String(state.browserToken || process.env.ZKBIO_BROWSER_TOKEN || '').trim();
            const response = await client.get('/accPersonLevelByDept.do', {
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                params: {
                    deptId: String(deptId || '').trim()
                },
                headers: buildBrowserHeaders({
                    sessionCookie: state.sessionCookie,
                    browserToken,
                    referer: 'http://localhost:8098/persPerson.do?edit&deptId=&deptName=',
                    requestedWith: 'XMLHttpRequest'
                })
            });

            log('info', 'zkbio.http.step', {
                step: 'accPersonLevelByDept',
                status: response.status
            });

            if (isRedirectToBioLogin(response)) {
                throw buildStepRedirectError('accPersonLevelByDept', response);
            }

            const levels = parseSimpleOptionsXml(response.data);
            log('info', 'zkbio.http.person-levels.found', {
                total: levels.length,
                levels
            });

            return levels;
        },

        async getAreas() {
            if (!state.sessionCookie) {
                const error = new Error('Debes ejecutar login() antes de getAreas()');
                error.code = 'ZKBIO_LOGIN_REQUIRED';
                error.statusCode = 401;
                throw error;
            }

            const browserToken = String(state.browserToken || process.env.ZKBIO_BROWSER_TOKEN || '').trim();
            const response = await client.get('/authArea.do', {
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                headers: buildBrowserHeaders({
                    sessionCookie: state.sessionCookie,
                    browserToken,
                    referer: 'http://localhost:8098/persPerson.do?edit&deptId=&deptName=',
                    requestedWith: 'XMLHttpRequest'
                })
            });

            log('info', 'zkbio.http.step', {
                step: 'authArea',
                status: response.status
            });

            if (isRedirectToBioLogin(response)) {
                throw buildStepRedirectError('authArea', response);
            }

            const areas = parseSimpleOptionsXml(response.data);
            log('info', 'zkbio.http.areas.found', {
                total: areas.length,
                areas
            });

            return areas;
        },

        async login(username, password) {
            const startedAt = Date.now();

            try {
                if (!username || !password) {
                    const error = new Error('username y password son obligatorios');
                    error.code = 'ZKBIO_LOGIN_REQUIRED';
                    error.statusCode = 400;
                    throw error;
                }

                await this.prepareLoginContext();

                const previousSessionCookie = state.sessionCookie;
                const browserToken = String(process.env.ZKBIO_BROWSER_TOKEN || state.browserToken || '').trim();
                const body = new URLSearchParams({
                    username: String(username).trim(),
                    password: md5(password),
                    checkCode: ''
                });
                if (browserToken) {
                    body.set('browserToken', browserToken);
                }

                log('info', 'zkbio.http.login.request', {
                    username: String(username).trim(),
                    hasBrowserToken: Boolean(browserToken)
                });

                const response = await client.post('/login.do', body.toString(), {
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        ...buildBrowserHeaders({
                            sessionCookie: state.preSessionCookie,
                            browserToken,
                            referer: 'http://localhost:8098/bioLogin.do',
                            origin: 'http://localhost:8098',
                            requestedWith: 'XMLHttpRequest'
                        })
                    }
                });

                log('info', 'zkbio.http.step', {
                    step: 'login',
                    status: response.status
                });

                if (isRedirectToBioLogin(response)) {
                    throw buildStepRedirectError('login', response);
                }

                const newSessionCookie = extractSessionCookie(response.headers['set-cookie']);
                state.sessionCookie = newSessionCookie;
                state.browserToken = browserToken || extractBrowserToken(response.data) || state.browserToken;

                if (!state.sessionCookie) {
                    const error = new Error('No se recibio cookie SESSION en el login');
                    error.code = 'ZKBIO_SESSION_MISSING';
                    error.statusCode = 502;
                    throw error;
                }

                if (previousSessionCookie && previousSessionCookie !== newSessionCookie) {
                    log('info', 'zkbio.http.login.session-rotated', {
                        rotated: true
                    });
                }

                log('info', 'zkbio.http.login.success', {
                    username: String(username).trim(),
                    durationMs: Date.now() - startedAt,
                    hasBrowserToken: Boolean(state.browserToken)
                });

                return {
                    ok: true,
                    sessionCookie: state.sessionCookie,
                    browserToken: state.browserToken || null
                };
            } catch (error) {
                log('error', 'zkbio.http.login.error', {
                    message: error.message,
                    code: error.code || null,
                    status: error.response?.status || error.statusCode || null
                });
                if (isOwnZkbioError(error)) {
                    throw error;
                }
                throw normalizeAxiosError(error, 'Error haciendo login en ZKBioAccess');
            }
        },

        async createUserWithPhoto(data = {}) {
            const startedAt = Date.now();

            try {
                if (!state.sessionCookie) {
                    const error = new Error('Debes ejecutar login() antes de createUserWithPhoto()');
                    error.code = 'ZKBIO_LOGIN_REQUIRED';
                    error.statusCode = 401;
                    throw error;
                }

                if (!data.personPhoto) {
                    const error = new Error('data.personPhoto es obligatorio');
                    error.code = 'ZKBIO_PHOTO_REQUIRED';
                    error.statusCode = 400;
                    throw error;
                }

                const browserToken = String(state.browserToken || data.browserToken || '').trim();
                if (!browserToken) {
                    const error = new Error('Falta browserToken');
                    error.code = 'ZKBIO_BROWSER_TOKEN_REQUIRED';
                    error.statusCode = 400;
                    throw error;
                }

                const photoPath = path.resolve(data.personPhoto);
                const photoBuffer = await fs.promises.readFile(photoPath);
                const form = new FormData();

                await this.prepareCreateUserContext();

                const payloadEntries = Array.isArray(data.formEntries)
                    ? data.formEntries
                    : Object.entries(data).filter(([, value]) => value != null);
                const resolvedDeptId = await resolveDepartmentId(this, payloadEntries);
                const resolvedPersonLevelId = await resolvePersonLevelId(this, payloadEntries, resolvedDeptId);
                const resolvedPersonAreaId = await resolvePersonAreaId(this, payloadEntries);
                const finalEntries = ensureRequiredCreateUserFields(applyResolvedSelections(payloadEntries, {
                    deptId: resolvedDeptId,
                    personLevelId: resolvedPersonLevelId,
                    personAreaId: resolvedPersonAreaId
                }), resolvedPersonAreaId);

                const validationForm = new FormData();
                validationForm.append('personPhoto', new Blob([photoBuffer]), path.basename(photoPath));

                const validPhotoResp = await client.post('/persPerson.do?validPersonPhoto', validationForm, {
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: {
                        ...buildBrowserHeaders({
                            sessionCookie: state.sessionCookie,
                            browserToken,
                            referer: 'http://localhost:8098/persPerson.do?edit&deptId=&deptName=',
                            origin: 'http://localhost:8098',
                            requestedWith: 'XMLHttpRequest'
                        })
                    }
                });

                const validPhotoRet = String(validPhotoResp?.data?.ret || '').trim();
                const validPhotoMsg = String(validPhotoResp?.data?.msg || '').trim();
                const validPhotoSuccess = validPhotoResp?.data?.success;
                const cropPhotoBase64 = typeof validPhotoResp?.data?.data === 'string'
                    ? validPhotoResp.data.data
                    : '';
                console.log('[zkbio] validPersonPhoto.ret:', validPhotoRet);
                console.log('[zkbio] validPersonPhoto.msg:', validPhotoMsg);
                console.log('[zkbio] cropPhotoBase64.length:', cropPhotoBase64.length);

                if (validPhotoRet !== 'ok' || !cropPhotoBase64) {
                    const error = new Error(`validPersonPhoto fallo. ret=${validPhotoRet || 'vacio'} msg=${validPhotoMsg || 'vacio'}`);
                    error.code = 'ZKBIO_VALID_PHOTO_FAILED';
                    error.statusCode = 502;
                    error.details = {
                        ret: validPhotoRet,
                        msg: validPhotoMsg,
                        success: validPhotoSuccess,
                        hasData: Boolean(cropPhotoBase64)
                    };
                    throw error;
                }

                upsertEntry(finalEntries, 'cropPhotoBase64', cropPhotoBase64);
                ensurePersonPhotoEntry(finalEntries);

                for (const entry of finalEntries) {
                    const [key, value] = entry;
                    if (key === 'formEntries') {
                        continue;
                    }

                    if (key === 'personPhoto') {
                        form.append('personPhoto', new Blob([photoBuffer]), path.basename(photoPath));
                        continue;
                    }

                    form.append(key, String(value));
                }

                const safeCreateLog = {
                    pin: data.pin || null,
                    name: data.name || null,
                    deptId: resolvedDeptId || null,
                    'att.personAreas': findEntryValue(finalEntries, 'att.personAreas') || null
                };

                log('info', 'zkbio.http.user.create.request', {
                    ...safeCreateLog
                });

                const response = await client.post('/persPerson.do?save', form, {
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: {
                        ...buildBrowserHeaders({
                            sessionCookie: state.sessionCookie,
                            browserToken,
                            referer: 'http://localhost:8098/main.do?home',
                            origin: 'http://localhost:8098',
                            requestedWith: 'XMLHttpRequest'
                        }),
                    }
                });

                const rawBody = serializeResponseBody(response.data);
                const parsedBody = parseCreateUserResponse(response.data);
                const isSuccess = isCreateUserSuccess(parsedBody, rawBody);
                const responseMeta = {
                    status: response.status,
                    location: response.headers?.location || '',
                    headers: pickRelevantHeaders(response.headers)
                };

                const durationMs = Date.now() - startedAt;
                const responseLog = {
                    ...safeCreateLog,
                    ret: parsedBody?.ret || '',
                    msg: parsedBody?.msg || '',
                    status: responseMeta.status,
                    durationMs
                };

                log('info', 'zkbio.http.user.create.response', responseLog);

                if (response.status === 302) {
                    const error = new Error(`ZKBioAccess respondio con redirect 302. Location: ${responseMeta.location || 'vacia'}`);
                    error.code = 'ZKBIO_CREATE_USER_REDIRECT';
                    error.statusCode = response.status;
                    error.details = {
                        location: responseMeta.location,
                        headers: responseMeta.headers,
                        rawBody
                    };
                    throw error;
                }

                if (isDuplicateUserResponse(parsedBody, rawBody)) {
                    const error = new Error('El ID de Usuario ya existe');
                    error.code = 'ZKBIO_USER_ALREADY_EXISTS';
                    error.statusCode = 409;
                    error.details = {
                        rawBody,
                        parsedBody
                    };
                    throw error;
                }

                if (!isSuccess) {
                    console.log('[zkbio] createUser rawBody:', rawBody);
                    const error = new Error(`ZKBioAccess no confirmo el alta. ret=${parsedBody?.ret || 'vacio'} msg=${parsedBody?.msg || 'vacio'}`);
                    error.code = 'ZKBIO_CREATE_USER_NOT_CONFIRMED';
                    error.statusCode = response.status || 502;
                    error.details = {
                        rawBody,
                        parsedBody
                    };
                    throw error;
                }

                log('info', 'zkbio.http.user.create.success', {
                    ...responseLog
                });

                const person = data.fetchAfterSave && data.pin
                    ? await this.getPersonByPin(data.pin).catch(error => {
                        log('warn', 'zkbio.http.user.fetch-after-save.failed', {
                            pin: data.pin,
                            message: error.message,
                            code: error.code || null
                        });
                        return null;
                    })
                    : null;

                return {
                    ok: true,
                    data: parsedBody,
                    rawBody,
                    status: response.status,
                    durationMs,
                    person
                };
            } catch (error) {
                log('error', 'zkbio.http.user.create.error', {
                    message: error.message,
                    code: error.code || null,
                    status: error.response?.status || error.statusCode || null
                });
                if (isOwnZkbioError(error)) {
                    throw error;
                }
                throw normalizeAxiosError(error, 'Error creando usuario con foto en ZKBioAccess');
            }
        },

        async updateUserWithPhoto(data = {}) {
            const startedAt = Date.now();

            try {
                if (!state.sessionCookie) {
                    const error = new Error('Debes ejecutar login() antes de updateUserWithPhoto()');
                    error.code = 'ZKBIO_LOGIN_REQUIRED';
                    error.statusCode = 401;
                    throw error;
                }

                if (!data.pin) {
                    const error = new Error('data.pin es obligatorio');
                    error.code = 'ZKBIO_PIN_REQUIRED';
                    error.statusCode = 400;
                    throw error;
                }

                if (!data.personPhoto) {
                    const error = new Error('data.personPhoto es obligatorio');
                    error.code = 'ZKBIO_PHOTO_REQUIRED';
                    error.statusCode = 400;
                    throw error;
                }

                const browserToken = String(state.browserToken || data.browserToken || '').trim();
                if (!browserToken) {
                    const error = new Error('Falta browserToken');
                    error.code = 'ZKBIO_BROWSER_TOKEN_REQUIRED';
                    error.statusCode = 400;
                    throw error;
                }

                await this.prepareCreateUserContext();

                const existingPerson = await this.getPersonByPin(data.pin);
                const internalId = String(existingPerson.person?.id || '').trim();

                if (!internalId) {
                    const error = new Error(`No se encontro id interno de ZKBio para PIN ${data.pin}`);
                    error.code = 'ZKBIO_USER_INTERNAL_ID_NOT_FOUND';
                    error.statusCode = 404;
                    error.details = { pin: data.pin };
                    throw error;
                }

                const photoPath = path.resolve(data.personPhoto);
                const photoBuffer = await fs.promises.readFile(photoPath);
                const form = new FormData();
                const payloadEntries = Array.isArray(data.formEntries)
                    ? data.formEntries
                    : Object.entries(data).filter(([, value]) => value != null);
                const resolvedDeptId = await resolveDepartmentId(this, payloadEntries);
                const resolvedPersonLevelId = await resolvePersonLevelId(this, payloadEntries, resolvedDeptId);
                const resolvedPersonAreaId = await resolvePersonAreaId(this, payloadEntries);
                const finalEntries = ensureRequiredCreateUserFields(applyResolvedSelections(payloadEntries, {
                    deptId: resolvedDeptId,
                    personLevelId: resolvedPersonLevelId,
                    personAreaId: resolvedPersonAreaId
                }), resolvedPersonAreaId);

                upsertEntry(finalEntries, 'logMethod', 'edit');
                upsertEntry(finalEntries, 'id', internalId);
                upsertEntry(finalEntries, 'pin', String(data.pin));
                if (data.name) {
                    upsertEntry(finalEntries, 'name', String(data.name));
                }

                const editResponse = await client.get('/persPerson.do?edit', {
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    params: {
                        id: internalId
                    },
                    headers: buildBrowserHeaders({
                        sessionCookie: state.sessionCookie,
                        browserToken,
                        referer: 'http://localhost:8098/main.do?home',
                        requestedWith: 'XMLHttpRequest'
                    })
                });

                log('info', 'zkbio.http.user.edit-context', {
                    pin: data.pin || null,
                    status: editResponse.status,
                    hasInternalId: Boolean(internalId)
                });

                if (isRedirectToBioLogin(editResponse)) {
                    throw buildStepRedirectError('persPerson.edit', editResponse);
                }

                const validationForm = new FormData();
                validationForm.append('personPhoto', new Blob([photoBuffer]), path.basename(photoPath));

                const validPhotoResp = await client.post('/persPerson.do?validPersonPhoto', validationForm, {
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: {
                        ...buildBrowserHeaders({
                            sessionCookie: state.sessionCookie,
                            browserToken,
                            referer: `http://localhost:8098/persPerson.do?edit&id=${encodeURIComponent(internalId)}`,
                            origin: 'http://localhost:8098',
                            requestedWith: 'XMLHttpRequest'
                        })
                    }
                });

                const validPhotoRet = String(validPhotoResp?.data?.ret || '').trim();
                const validPhotoMsg = String(validPhotoResp?.data?.msg || '').trim();
                const validPhotoSuccess = validPhotoResp?.data?.success;
                const cropPhotoBase64 = typeof validPhotoResp?.data?.data === 'string'
                    ? validPhotoResp.data.data
                    : '';
                console.log('[zkbio] update.validPersonPhoto.ret:', validPhotoRet);
                console.log('[zkbio] update.validPersonPhoto.msg:', validPhotoMsg);
                console.log('[zkbio] update.cropPhotoBase64.length:', cropPhotoBase64.length);

                if (validPhotoRet !== 'ok' || !cropPhotoBase64) {
                    const error = new Error(`validPersonPhoto fallo. ret=${validPhotoRet || 'vacio'} msg=${validPhotoMsg || 'vacio'}`);
                    error.code = 'ZKBIO_VALID_PHOTO_FAILED';
                    error.statusCode = 502;
                    error.details = {
                        ret: validPhotoRet,
                        msg: validPhotoMsg,
                        success: validPhotoSuccess,
                        hasData: Boolean(cropPhotoBase64)
                    };
                    throw error;
                }

                upsertEntry(finalEntries, 'cropPhotoBase64', cropPhotoBase64);

                for (const entry of finalEntries) {
                    const [key, value] = entry;
                    if (key === 'personPhoto' || key === 'formEntries') {
                        continue;
                    }

                    form.append(key, String(value));
                }

                form.append('personPhoto', new Blob([photoBuffer]), path.basename(photoPath));

                const safeUpdateLog = {
                    pin: data.pin || null,
                    deptId: resolvedDeptId || null,
                    personLevelId: resolvedPersonLevelId || null,
                    personAreaId: resolvedPersonAreaId || null,
                    cropPhotoBase64Length: cropPhotoBase64.length
                };

                log('info', 'zkbio.http.user.update.request', {
                    ...safeUpdateLog
                });

                const response = await client.post('/persPerson.do?save', form, {
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: {
                        ...buildBrowserHeaders({
                            sessionCookie: state.sessionCookie,
                            browserToken,
                            referer: `http://localhost:8098/persPerson.do?edit&id=${encodeURIComponent(internalId)}`,
                            origin: 'http://localhost:8098',
                            requestedWith: 'XMLHttpRequest'
                        }),
                    }
                });

                const rawBody = serializeResponseBody(response.data);
                const parsedBody = parseCreateUserResponse(response.data);
                const isSuccess = isCreateUserSuccess(parsedBody, rawBody);
                const responseMeta = {
                    status: response.status,
                    location: response.headers?.location || '',
                    headers: pickRelevantHeaders(response.headers)
                };
                const durationMs = Date.now() - startedAt;
                const responseLog = {
                    ...safeUpdateLog,
                    ret: parsedBody?.ret || '',
                    msg: parsedBody?.msg || '',
                    durationMs
                };

                log('info', 'zkbio.http.user.update.response', {
                    ...responseLog,
                    status: responseMeta.status
                });

                if (response.status === 302) {
                    const error = new Error(`ZKBioAccess respondio con redirect 302. Location: ${responseMeta.location || 'vacia'}`);
                    error.code = 'ZKBIO_UPDATE_USER_REDIRECT';
                    error.statusCode = response.status;
                    error.details = {
                        location: responseMeta.location,
                        headers: responseMeta.headers,
                        rawBody
                    };
                    throw error;
                }

                if (!isSuccess) {
                    const error = new Error(`ZKBioAccess no confirmo la actualizacion. ret=${parsedBody?.ret || 'vacio'} msg=${parsedBody?.msg || 'vacio'}`);
                    error.code = 'ZKBIO_UPDATE_USER_NOT_CONFIRMED';
                    error.statusCode = response.status || 502;
                    error.details = {
                        rawBody,
                        parsedBody
                    };
                    throw error;
                }

                log('info', 'zkbio.http.user.update.success', {
                    ...responseLog
                });

                return {
                    ok: true,
                    data: parsedBody,
                    rawBody,
                    status: response.status,
                    durationMs,
                    person: {
                        id: internalId,
                        pin: String(data.pin)
                    }
                };
            } catch (error) {
                log('error', 'zkbio.http.user.update.error', {
                    message: error.message,
                    code: error.code || null,
                    status: error.response?.status || error.statusCode || null
                });
                if (isOwnZkbioError(error)) {
                    throw error;
                }
                throw normalizeAxiosError(error, 'Error actualizando usuario con foto en ZKBioAccess');
            }
        },

        async getPersonByPin(pin) {
            if (!state.sessionCookie) {
                const error = new Error('Debes ejecutar login() antes de getPersonByPin()');
                error.code = 'ZKBIO_LOGIN_REQUIRED';
                error.statusCode = 401;
                throw error;
            }

            const browserToken = String(state.browserToken || process.env.ZKBIO_BROWSER_TOKEN || '').trim();
            const response = await client.get('/persPerson.do', {
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                params: {
                    pin: String(pin || '').trim()
                },
                headers: buildBrowserHeaders({
                    sessionCookie: state.sessionCookie,
                    browserToken,
                    referer: 'http://localhost:8098/main.do?home&selectSysCode=Pers',
                    requestedWith: 'XMLHttpRequest'
                })
            });

            log('info', 'zkbio.http.user.fetch-after-save', {
                pin: String(pin || '').trim(),
                status: response.status
            });

            if (isRedirectToBioLogin(response)) {
                throw buildStepRedirectError('persPerson.fetch', response);
            }

            const body = serializeResponseBody(response.data);
            const person = parsePersonLookupResponse(response.data, pin) || parsePersonLookupResponse(body, pin);

            return {
                status: response.status,
                body,
                person
            };
        }
    };

    api.__log = log;
    return api;

    function log(level, event, details) {
        if (logStore && typeof logStore[level] === 'function') {
            logStore[level](event, details);
            return;
        }

        const line = `[zkbio-http] ${event} ${JSON.stringify(details || {})}`;
        if (level === 'error') {
            console.error(line);
            return;
        }

        console.log(line);
    }
}

function md5(value) {
    return crypto.createHash('md5').update(String(value)).digest('hex');
}

function extractSessionCookie(setCookieHeader) {
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [];
    const session = cookies.find(cookie => /^SESSION=/i.test(cookie));
    return session ? session.split(';')[0] : '';
}

function extractBrowserToken(payload) {
    if (payload == null) {
        return '';
    }

    if (typeof payload === 'object' && payload.browserToken) {
        return String(payload.browserToken).trim();
    }

    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const match = text.match(/browserToken["']?\s*[:=]\s*["']([^"']+)["']/i);
    return match ? match[1].trim() : '';
}

async function resolveDepartmentId(service, payloadEntries) {
    const deptName = String(process.env.ZKBIO_DEPT_NAME || '').trim();
    const payloadDeptId = String(findEntryValue(payloadEntries, 'deptId') || '').trim();
    const fallbackDeptId = String(process.env.ZKBIO_DEPT_ID || payloadDeptId || '').trim();

    if (!deptName) {
        return fallbackDeptId;
    }

    const departments = await service.getDepartments();
    const selected = findDepartmentByName(departments, deptName);

    serviceLog(service, 'info', 'zkbio.http.departments.selected', {
        deptName,
        selected: selected || null,
        fallbackDeptId
    });

    return selected?.id || fallbackDeptId;
}

async function resolvePersonLevelId(service, payloadEntries, deptId) {
    const levelName = String(process.env.ZKBIO_PERSON_LEVEL_NAME || '').trim();
    const fallbackPersonLevelId = String(process.env.ZKBIO_PERSON_LEVEL_ID || findEntryValue(payloadEntries, 'acc.personLevelIds') || '').trim();

    if (!levelName || !deptId) {
        return fallbackPersonLevelId;
    }

    const levels = await service.getPersonLevels(deptId);
    const selected = levels.find(level => level.name.toLowerCase() === levelName.toLowerCase());

    serviceLog(service, 'info', 'zkbio.http.person-levels.selected', {
        personLevelName: levelName,
        selected: selected || null,
        fallbackPersonLevelId
    });

    return selected?.id || fallbackPersonLevelId;
}

async function resolvePersonAreaId(service, payloadEntries) {
    const areaName = String(process.env.ZKBIO_PERSON_AREA_NAME || '').trim();
    const fallbackPersonAreaId = normalizeCommaSeparatedIds(process.env.ZKBIO_PERSON_AREA_ID || findEntryValue(payloadEntries, 'att.personAreas') || '');

    if (fallbackPersonAreaId) {
        return fallbackPersonAreaId;
    }

    if (!areaName) {
        return '';
    }

    const areas = await service.getAreas();
    const selected = findAreaByName(areas, areaName);

    serviceLog(service, 'info', 'zkbio.http.areas.selected', {
        personAreaName: areaName,
        selected: selected || null,
        fallbackPersonAreaId
    });

    return selected?.id || fallbackPersonAreaId;
}

function normalizeAxiosError(error, fallbackMessage) {
    const responseData = error.response?.data;
    const responseText = serializeResponseBody(responseData).slice(0, 1000);
    const normalized = new Error(error.message || fallbackMessage);

    normalized.code = error.code || 'ZKBIO_HTTP_ERROR';
    normalized.statusCode = error.response?.status || error.statusCode || 500;
    normalized.details = {
        message: fallbackMessage,
        response: responseText || null
    };

    return normalized;
}

function parseCreateUserResponse(payload) {
    if (payload == null) {
        return {};
    }

    if (typeof payload === 'object') {
        return payload;
    }

    const text = String(payload).trim();
    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch (_error) {
        return {
            raw: text,
            ret: extractMatch(text, /["']?ret["']?\s*[:=]\s*["']?([^"',}<\s]+)/i),
            msg: extractMatch(text, /["']?msg["']?\s*[:=]\s*["']([^"']+)/i) || extractHtmlTitle(text),
            success: /operaci[oó]n\s+exitosa|operation\s+successful/i.test(text)
        };
    }
}

function isCreateUserSuccess(parsedBody, rawBody) {
    const ret = String(parsedBody?.ret || '').trim().toLowerCase();
    const success = parsedBody?.success === true;
    const bodyText = String(rawBody || '');
    return ret === 'ok' || success || /operaci[oó]n\s+exitosa/i.test(bodyText);
}

function isDuplicateUserResponse(parsedBody, rawBody) {
    const bodyText = String(parsedBody?.msg || rawBody || '').trim();
    return /el id de usuario ya existe/i.test(bodyText);
}

function parsePersonLookupResponse(payload, pin) {
    const parsedPayload = parseJsonPayload(payload);
    const recordFromJson = findPersonRecord(parsedPayload, pin);
    if (recordFromJson) {
        return recordFromJson;
    }

    const text = typeof payload === 'string' ? payload : serializeResponseBody(payload);
    return extractPersonRecordFromText(text, pin);
}

function parseJsonPayload(payload) {
    if (payload && typeof payload === 'object') {
        return payload;
    }

    const text = String(payload || '').trim();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (_error) {
        return null;
    }
}

function findPersonRecord(value, pin) {
    if (!value) {
        return null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findPersonRecord(item, pin);
            if (found) {
                return found;
            }
        }
        return null;
    }

    if (typeof value !== 'object') {
        return null;
    }

    const expectedPin = String(pin || '').trim();
    const recordPin = firstNonEmptyValue(value.pin, value.PIN, value.personPin, value.personnelNo, value.employeeNo);
    const id = firstNonEmptyValue(value.id, value.ID, value.personId, value.personID, value.person_id);

    if (id && expectedPin && String(recordPin || '').trim() === expectedPin) {
        return {
            id: String(id).trim(),
            pin: expectedPin,
            name: firstNonEmptyValue(value.name, value.firstName, value.lastName)
        };
    }

    for (const item of Object.values(value)) {
        const found = findPersonRecord(item, pin);
        if (found) {
            return found;
        }
    }

    return null;
}

function extractPersonRecordFromText(text, pin) {
    const expectedPin = String(pin || '').trim();
    if (!text || !expectedPin) {
        return null;
    }

    const escapedPin = escapeRegExp(expectedPin);
    const jsonLikeRow = String(text).match(new RegExp(`\\{[^{}]*(?:"pin"|"PIN"|"personnelNo"|"employeeNo")\\s*:\\s*"?${escapedPin}"?[^{}]*\\}`, 'i'));
    const htmlRow = String(text).match(new RegExp(`<tr\\b[^>]*>[\\s\\S]*?${escapedPin}[\\s\\S]*?<\\/tr>`, 'i'));
    const source = jsonLikeRow?.[0] || htmlRow?.[0] || String(text);
    const id = firstMatch(source, [
        /["'](?:id|ID|personId|personID|person_id)["']?\s*[:=]\s*["']([^"',}<\s]+)/i,
        /persPerson\.do\?edit[^"']*id=([^&"']+)/i,
        /(?:edit|doEdit|editPerson)\s*\(\s*["']([^"']+)["']/i,
        /\bdata-id=["']([^"']+)["']/i
    ]);

    return id ? { id, pin: expectedPin } : null;
}

function firstNonEmptyValue(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) {
            return text;
        }
    }

    return '';
}

function firstMatch(text, patterns) {
    for (const pattern of patterns) {
        const match = String(text || '').match(pattern);
        if (match && match[1]) {
            try {
                return decodeURIComponent(match[1]).trim();
            } catch (_error) {
                return String(match[1]).trim();
            }
        }
    }

    return '';
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeResponseBody(payload) {
    if (payload == null) {
        return '';
    }

    if (typeof payload === 'string') {
        return payload;
    }

    try {
        return JSON.stringify(payload);
    } catch (_error) {
        return String(payload);
    }
}

function extractFormEntries(form) {
    const keys = [];
    const values = {};
    const items = [];

    for (const [key, value] of form.entries()) {
        keys.push(key);

        if (key === 'personPhoto') {
            values[key] = '[binary file]';
            items.push({ key, value: '[binary file]' });
            continue;
        }

        if (key === 'browserToken') {
            values[key] = '[present]';
            items.push({ key, value: '[present]' });
            continue;
        }

        if (key === 'cropPhotoBase64') {
            const length = typeof value === 'string' ? value.length : 0;
            values[key] = `[length:${length}]`;
            items.push({ key, value: `[length:${length}]` });
            continue;
        }

        if (key === 'bioTemplateJson') {
            const length = typeof value === 'string' ? value.length : 0;
            values[key] = `[present:${length > 0};length:${length}]`;
            items.push({ key, value: `[present:${length > 0};length:${length}]` });
            continue;
        }

        values[key] = typeof value === 'string' ? value : '[non-string]';
        items.push({ key, value: typeof value === 'string' ? value : '[non-string]' });
    }

    return { keys, values, items };
}

function isOwnZkbioError(error) {
    return Boolean(error && typeof error.code === 'string' && error.code.startsWith('ZKBIO_'));
}

function parseDepartmentsXml(payload) {
    const text = typeof payload === 'string' ? payload : String(payload || '');

    const itemMatches = [...text.matchAll(/<item[^>]*id="([^"]+)"[^>]*text="([^"]+)"/g)];

    if (itemMatches.length > 0) {
        const departments = itemMatches.map(([, id, name]) => ({
            id: decodeXml(String(id || '')).trim(),
            name: normalizeDepartmentName(decodeXml(String(name || '')).trim())
        })).filter(department => department.id && department.name);

        return departments;
    }

    const rows = [...text.matchAll(/<row\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/row>/gi)];

    if (rows.length > 0) {
        return rows.map(([, id, content]) => ({
            id: String(id || '').trim(),
            name: normalizeDepartmentName(decodeXml(extractFirstCell(content)).trim())
        })).filter(department => department.id && department.name);
    }

    const items = [...text.matchAll(/<id>([^<]+)<\/id>[\s\S]*?<name>([^<]+)<\/name>/gi)];
    return items.map(([, id, name]) => ({
        id: decodeXml(id).trim(),
        name: normalizeDepartmentName(decodeXml(name).trim())
    })).filter(department => department.id && department.name);
}

function applyResolvedSelections(entries, resolved) {
    return entries.map(([key, value]) => {
        if (key === 'deptId' && resolved.deptId) {
            return [key, resolved.deptId];
        }

        if ((key === 'acc.personLevelIds' || key === PERSON_LEVEL_DYNAMIC_INPUT) && resolved.personLevelId) {
            return [key, resolved.personLevelId];
        }

        if (key === 'att.personAreas' && resolved.personAreaId) {
            return [key, normalizeCommaSeparatedIds(resolved.personAreaId)];
        }

        return [key, value];
    });
}

function ensureRequiredCreateUserFields(entries, resolvedPersonAreaId) {
    const nextEntries = [...entries];

    upsertEntry(nextEntries, 'moduleAuth', 'acc,att,');
    upsertEntry(nextEntries, 'att.isAttendance', 'true');
    upsertEntry(nextEntries, 'att.verifyMode', '');
    upsertEntry(nextEntries, 'att.verifyMode_new_value', 'false');
    upsertEntry(nextEntries, 'accPersonLevelFilterIds', '');
    upsertEntry(nextEntries, 'logMethod', 'add');

    const personAreaId = normalizeCommaSeparatedIds(resolvedPersonAreaId || findEntryValue(nextEntries, 'att.personAreas') || '');
    upsertEntry(nextEntries, 'att.personAreas', personAreaId);

    const personLevelId = String(findEntryValue(nextEntries, 'acc.personLevelIds') || '').trim();
    for (const legacyInput of LEGACY_PERSON_LEVEL_INPUTS) {
        removeEntry(nextEntries, legacyInput);
    }
    upsertEntry(nextEntries, PERSON_LEVEL_DYNAMIC_INPUT, personLevelId);

    return nextEntries;
}

function parseSimpleOptionsXml(payload) {
    const text = typeof payload === 'string' ? payload : serializeResponseBody(payload);
    const items = [...text.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*text="([^"]+)"[^>]*\/?>/gi)];

    if (items.length > 0) {
        return items.map(([, id, name]) => ({
            id: decodeXml(String(id || '')).trim(),
            name: decodeXml(String(name || '')).trim()
        })).filter(item => item.id && item.name);
    }

    const rows = [...text.matchAll(/<row\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/row>/gi)];

    if (rows.length > 0) {
        return rows.map(([, id, content]) => ({
            id: decodeXml(String(id || '')).trim(),
            name: decodeXml(extractOptionName(content)).trim()
        })).filter(item => item.id && item.name);
    }

    const options = [...text.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi)];
    return options.map(([, id, name]) => ({
        id: decodeXml(id).trim(),
        name: decodeXml(stripTags(name)).trim()
    })).filter(item => item.id && item.name);
}

function findAreaByName(areas, expectedName) {
    const normalizedExpectedName = normalizeAreaName(expectedName);

    if (!normalizedExpectedName) {
        return null;
    }

    return areas.find(area => {
        const normalizedAreaName = normalizeAreaName(area?.name);
        return normalizedAreaName === normalizedExpectedName ||
            normalizedAreaName.startsWith(`${normalizedExpectedName} `) ||
            normalizedAreaName.startsWith(`${normalizedExpectedName}-`) ||
            normalizedAreaName.startsWith(`${normalizedExpectedName}(`);
    }) || null;
}

function findDepartmentByName(departments, expectedName) {
    const normalizedExpectedName = normalizeDepartmentLookupName(expectedName);

    if (!normalizedExpectedName) {
        return null;
    }

    return departments.find(department => {
        const normalizedDepartmentName = normalizeDepartmentLookupName(department?.name);
        return normalizedDepartmentName === normalizedExpectedName ||
            normalizedDepartmentName.startsWith(`${normalizedExpectedName} `) ||
            normalizedDepartmentName.startsWith(`${normalizedExpectedName}-`) ||
            normalizedDepartmentName.startsWith(`${normalizedExpectedName}(`);
    }) || null;
}

function normalizeCommaSeparatedIds(value) {
    const items = String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    return items.length > 0 ? `${items.join(',')},` : '';
}

function findEntryValue(entries, targetKey) {
    const entry = entries.find(([key]) => key === targetKey);
    return entry ? entry[1] : '';
}

function upsertEntry(entries, targetKey, value) {
    const index = entries.findIndex(([key]) => key === targetKey);
    if (index >= 0) {
        entries[index] = [targetKey, value];
        return;
    }

    entries.push([targetKey, value]);
}

function removeEntry(entries, targetKey) {
    const index = entries.findIndex(([key]) => key === targetKey);
    if (index >= 0) {
        entries.splice(index, 1);
    }
}

function ensurePersonPhotoEntry(entries) {
    const existingIndex = entries.findIndex(([key]) => key === 'personPhoto');
    if (existingIndex >= 0) {
        return;
    }

    const personLevelIndex = entries.findIndex(([key]) => key === 'acc.personLevelIds');
    if (personLevelIndex >= 0) {
        entries.splice(personLevelIndex, 0, ['personPhoto', '']);
        return;
    }

    entries.push(['personPhoto', '']);
}

function extractFirstCell(content) {
    const match = content.match(/<cell[^>]*>([\s\S]*?)<\/cell>/i);
    return match ? stripTags(match[1]) : '';
}

function extractOptionName(content) {
    const cells = [...String(content || '').matchAll(/<cell[^>]*>([\s\S]*?)<\/cell>/gi)];
    if (cells.length > 1) {
        return stripTags(cells[1][1]);
    }

    if (cells.length === 1) {
        return stripTags(cells[0][1]);
    }

    return stripTags(content);
}

function stripTags(value) {
    return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeXml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function normalizeDepartmentName(value) {
    return String(value || '').replace(/\(\d+\)\s*$/, '').trim();
}

function normalizeDepartmentLookupName(value) {
    return normalizeDepartmentName(value)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeAreaName(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function serviceLog(service, level, event, details) {
    if (service && service.__log) {
        service.__log(level, event, details);
    }
}

function pickRelevantHeaders(headers = {}) {
    return {
        location: headers.location || '',
        'content-type': headers['content-type'] || '',
        'content-length': headers['content-length'] || '',
        'set-cookie': headers['set-cookie'] || []
    };
}

function buildBrowserHeaders({ sessionCookie, browserToken, referer, origin, requestedWith }) {
    const headers = {
        Cookie: sessionCookie || '',
        'browser-token': browserToken || '',
        Referer: referer || 'http://localhost:8098/main.do?home',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
    };

    if (origin) {
        headers.Origin = origin;
    }

    if (requestedWith) {
        headers['X-Requested-With'] = requestedWith;
    }

    return headers;
}

function isRedirectToBioLogin(response) {
    return response.status >= 300 &&
        response.status < 400 &&
        /\/bioLogin\.do(?:\?|$)/i.test(String(response.headers?.location || ''));
}

function buildStepRedirectError(step, response) {
    const error = new Error(`ZKBioAccess redirigio a /bioLogin.do en el paso ${step}`);
    error.code = 'ZKBIO_CONTEXT_REDIRECT';
    error.statusCode = response.status;
    error.details = {
        step,
        location: response.headers?.location || '',
        headers: pickRelevantHeaders(response.headers)
    };
    return error;
}

function extractMatch(text, regex) {
    const match = text.match(regex);
    return match ? match[1].trim() : '';
}

function extractHtmlTitle(text) {
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : '';
}

module.exports = {
    createZkbioAccessHttpService
};
