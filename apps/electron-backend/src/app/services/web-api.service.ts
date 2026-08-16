import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import axios, { type AxiosRequestConfig } from 'axios';
import { normalizeXtreamServerUrl } from '@arm-nator/shared/interfaces';
import { databaseWorkerClient } from './database-worker-client';
import {
    DB_WORKER_OPERATIONS,
    type DbWorkerOperation,
} from '../workers/database-worker.types';
import { requestWithValidatedRedirects } from '../util/validated-axios';

export const webApiHost = '127.0.0.1';
export const webApiPort = Number.parseInt(
    process.env['ARM_NATOR_WEB_API_PORT'] ?? '4310',
    10
);

const webApiPath = '/api';
const maxRequestBodyBytes = 50 * 1024 * 1024;
const allowedDatabaseOperations = new Set<string>(DB_WORKER_OPERATIONS);
const xtreamUserAgent = 'VLC/3.0.18 LibVLC/3.0.18';

let webApiServer: Server | null = null;

type JsonObject = Record<string, unknown>;

function isAllowedOrigin(origin: string): boolean {
    try {
        const parsedOrigin = new URL(origin);
        return (
            (parsedOrigin.protocol === 'http:' ||
                parsedOrigin.protocol === 'https:') &&
            (parsedOrigin.hostname === 'localhost' ||
                parsedOrigin.hostname === '127.0.0.1' ||
                parsedOrigin.hostname === '[::1]')
        );
    } catch {
        return false;
    }
}

function setCorsHeaders(response: ServerResponse, origin?: string): void {
    if (origin && isAllowedOrigin(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(
    response: ServerResponse,
    statusCode: number,
    payload: unknown,
    origin?: string
): void {
    setCorsHeaders(response, origin);
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        request.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.byteLength;
            if (totalBytes > maxRequestBodyBytes) {
                reject(new Error('Request body is too large'));
                request.destroy();
                return;
            }
            chunks.push(buffer);
        });
        request.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('Request body must be valid JSON'));
            }
        });
        request.on('error', reject);
    });
}

function getOrigin(request: IncomingMessage): string | undefined {
    const origin = request.headers.origin;
    return typeof origin === 'string' ? origin : undefined;
}

function buildXtreamApiUrl(
    url: string,
    params: Record<string, string>
): URL {
    const apiUrl = new URL(`${normalizeXtreamServerUrl(url)}/player_api.php`);
    Object.entries(params).forEach(([key, value]) => {
        apiUrl.searchParams.append(
            key,
            key === 'username' || key === 'password' ? value.trim() : value
        );
    });
    return apiUrl;
}

async function requestXtream(payload: {
    url: string;
    params: Record<string, string>;
}): Promise<{ payload: unknown; action?: string }> {
    const apiUrl = buildXtreamApiUrl(payload.url, payload.params);
    const config: AxiosRequestConfig = {
        method: 'GET',
        url: apiUrl.toString(),
        headers: {
            'User-Agent': xtreamUserAgent,
            Accept: 'application/json',
        },
        timeout: 30000,
        validateStatus: (status) => status < 500,
    };
    const response = await requestWithValidatedRedirects<unknown>(
        apiUrl.toString(),
        config,
        { allowPrivateNetworks: true }
    );

    if (response.status >= 400) {
        throw Object.assign(new Error(`HTTP Error: ${response.statusText}`), {
            status: response.status,
        });
    }

    return {
        payload: response.data,
        action: payload.params.action,
    };
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const origin = getOrigin(request);
    const requestUrl = new URL(request.url ?? '/', `http://${webApiHost}:${webApiPort}`);

    if (request.method === 'OPTIONS') {
        setCorsHeaders(response, origin);
        response.statusCode = 204;
        response.end();
        return;
    }

    if (requestUrl.pathname === `${webApiPath}/health` && request.method === 'GET') {
        sendJson(response, 200, { ok: true, database: true }, origin);
        return;
    }

    if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' }, origin);
        return;
    }

    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(response, 400, { error: 'Request body must be an object' }, origin);
        return;
    }

    if (requestUrl.pathname === `${webApiPath}/db`) {
        const { operation, payload } = body as JsonObject;
        if (typeof operation !== 'string' || !allowedDatabaseOperations.has(operation)) {
            sendJson(response, 400, { error: 'Unsupported database operation' }, origin);
            return;
        }

        const result = await databaseWorkerClient.request(
            operation as DbWorkerOperation,
            payload ?? {}
        );
        sendJson(response, 200, { result }, origin);
        return;
    }

    if (requestUrl.pathname === `${webApiPath}/db/cancel`) {
        const operationId = (body as JsonObject).operationId;
        if (typeof operationId !== 'string' || operationId.length === 0) {
            sendJson(response, 400, { error: 'operationId is required' }, origin);
            return;
        }

        sendJson(
            response,
            200,
            { result: await databaseWorkerClient.cancel(operationId) },
            origin
        );
        return;
    }

    if (requestUrl.pathname === `${webApiPath}/xtream`) {
        const payload = body as JsonObject;
        if (
            typeof payload.url !== 'string' ||
            !payload.params ||
            typeof payload.params !== 'object' ||
            Array.isArray(payload.params)
        ) {
            sendJson(response, 400, { error: 'Invalid Xtream request' }, origin);
            return;
        }

        const result = await requestXtream({
            url: payload.url,
            params: payload.params as Record<string, string>,
        });
        sendJson(response, 200, result, origin);
        return;
    }

    sendJson(response, 404, { error: 'Not found' }, origin);
}

export async function startWebApi(): Promise<void> {
    if (webApiServer) {
        return;
    }

    const server = createServer((request, response) => {
        void handleRequest(request, response).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[Web API] Request failed:', message);
            if (!response.headersSent) {
                sendJson(response, 500, { error: message }, getOrigin(request));
            } else {
                response.destroy();
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(webApiPort, webApiHost);
    });

    webApiServer = server;
    console.info(`[Web API] Listening on http://${webApiHost}:${webApiPort}${webApiPath}`);
}

export async function stopWebApi(): Promise<void> {
    const server = webApiServer;
    webApiServer = null;
    if (!server) {
        return;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
}
