import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
    OpenSubtitlesDownloadRequest,
    OpenSubtitlesDownloadedSubtitle,
    OpenSubtitlesSearchRequest,
    OpenSubtitlesSearchResult,
} from '@arm-nator/shared/interfaces';

const OPEN_SUBTITLES_URL =
    'https://api.opensubtitles.com/api/v1/subtitles';
const OPEN_SUBTITLES_USER_AGENT = 'ARM-Nator/1.0';
// Personal/local-build fallback supplied by the app owner. An environment
// variable still takes precedence so packaged or shared builds can override it.
const PERSONAL_OPEN_SUBTITLES_API_KEY =
    'nkQbMK23XqwLM91bgNkjIJ9vHNfJyoBd';

interface OpenSubtitlesApiSubtitle {
    id?: unknown;
    attributes?: {
        language?: unknown;
        download_count?: unknown;
        fps?: unknown;
        upload_date?: unknown;
        release?: unknown;
        from_trusted?: unknown;
        hearing_impaired?: unknown;
        feature_details?: {
            year?: unknown;
        } | null;
        files?: Array<{
            file_id?: unknown;
            file_name?: unknown;
        }>;
    };
}

interface OpenSubtitlesApiResponse {
    data?: OpenSubtitlesApiSubtitle[];
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}

function asNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeLanguages(value: string | undefined): string {
    const languages = (value ?? 'ar')
        .split(',')
        .map((language) => language.trim().toLowerCase())
        .filter(Boolean)
        .join(',');
    return languages || 'ar';
}

function sanitizeFilename(value: string): string {
    const cleaned = value
        .replace(/[/:\\?%*|"<>]/g, '-')
        .replace(/\.\.+/g, '.')
        .trim();
    return cleaned || 'subtitle.srt';
}

function isInside(directory: string, filePath: string): boolean {
    const root = resolve(directory);
    const target = resolve(filePath);
    return target === root || target.startsWith(`${root}/`);
}

function toWebVttDataUrl(data: Buffer, fileName: string): string {
    const lowerName = fileName.toLowerCase();
    if (!lowerName.endsWith('.srt') && !lowerName.endsWith('.vtt')) {
        return '';
    }

    const text = data.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!text || text.includes('\u0000') || text.includes('\uFFFD')) {
        return '';
    }

    const webVtt = text.startsWith('WEBVTT')
        ? text
        : `WEBVTT\n\n${text.replace(
              /(\d{1,2}:\d{2}(?::\d{2})?),(\d{3})/g,
              '$1.$2'
          )}`;
    return `data:text/vtt;base64,${Buffer.from(webVtt, 'utf8').toString(
        'base64'
    )}`;
}

interface SubtitleCacheMetadata {
    fileId: number;
    fileName: string;
    language: string;
    label: string;
    filePath: string;
}

function normalizeForRanking(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractYear(value: string): number | null {
    const match = value.match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : null;
}

function scoreResult(
    result: OpenSubtitlesSearchResult,
    query: string,
    year: number | null
): number {
    const searchable = normalizeForRanking(
        `${result.fileName} ${result.release}`
    );
    let score = 0;
    if (query) {
        if (searchable === query) score += 160;
        if (searchable.includes(query)) score += 90;
        score += query
            .split(' ')
            .filter((word) => searchable.includes(word)).length * 12;
    }
    if (year !== null && result.year === year) score += 80;
    if (result.trusted) score += 25;
    if (!result.hearingImpaired) score += 8;
    return score + Math.min(Math.floor(result.downloads / 100), 25);
}

function rankResults(
    results: OpenSubtitlesSearchResult[],
    rawQuery: string
): OpenSubtitlesSearchResult[] {
    const query = normalizeForRanking(rawQuery);
    const year = extractYear(rawQuery);
    return results
        .map((result, index) => ({
            result,
            index,
            score: scoreResult(result, query, year),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map(({ result }) => result);
}

function errorMessage(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body) as { message?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
            return `OpenSubtitles HTTP ${status}: ${parsed.message}`;
        }
    } catch {
        // Fall through to a safe status-only message.
    }
    return `OpenSubtitles HTTP ${status}.`;
}

export class OpenSubtitlesService {
    private readonly cacheDirectory = join(
        app.getPath('userData'),
        'subtitles',
        'opensubtitles'
    );

    private getApiKey(): string {
        return (
            process.env.OPENSUBTITLES_API_KEY?.trim() ||
            PERSONAL_OPEN_SUBTITLES_API_KEY
        );
    }

    private headers(apiKey: string, includeContentType = false): HeadersInit {
        return {
            Accept: '*/*',
            'Api-Key': apiKey,
            'User-Agent': OPEN_SUBTITLES_USER_AGENT,
            ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
        };
    }

    async search(
        request: OpenSubtitlesSearchRequest
    ): Promise<OpenSubtitlesSearchResult[]> {
        const query = request.query.trim();
        if (query.length < 2) {
            throw new Error('Enter at least two characters to search subtitles.');
        }

        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error(
                'OpenSubtitles is not configured. Set OPENSUBTITLES_API_KEY before starting ARM-Nator.'
            );
        }

        const url = new URL(OPEN_SUBTITLES_URL);
        url.searchParams.set('languages', normalizeLanguages(request.languages));
        url.searchParams.set('query', query);

        const response = await fetch(url, {
            method: 'GET',
            headers: this.headers(apiKey),
            signal: AbortSignal.timeout(15_000),
        });
        const body = await response.text();
        if (!response.ok) {
            throw new Error(errorMessage(response.status, body));
        }

        let payload: OpenSubtitlesApiResponse;
        try {
            payload = JSON.parse(body) as OpenSubtitlesApiResponse;
        } catch {
            throw new Error('OpenSubtitles returned an unreadable response.');
        }

        if (!Array.isArray(payload.data)) {
            throw new Error('OpenSubtitles returned an unreadable response.');
        }

        const results = payload.data.flatMap((subtitle) => {
            const attributes = subtitle.attributes;
            const file = attributes?.files?.[0];
            const fileId = asNumber(file?.file_id, -1);
            const id = asString(subtitle.id);
            if (!id || fileId < 0 || !file?.file_name) {
                return [];
            }
            return [
                {
                    id,
                    fileId,
                    fileName: asString(file.file_name),
                    language: asString(attributes?.language, 'unknown'),
                    downloads: asNumber(attributes?.download_count),
                    fps: asNullableNumber(attributes?.fps),
                    uploadDate: asString(attributes?.upload_date),
                    release: asString(attributes?.release, asString(file.file_name)),
                    year: asNullableNumber(attributes?.feature_details?.year),
                    trusted: attributes?.from_trusted === true,
                    hearingImpaired: attributes?.hearing_impaired === true,
                } satisfies OpenSubtitlesSearchResult,
            ];
        });

        return rankResults(results, query);
    }

    async download(
        request: OpenSubtitlesDownloadRequest
    ): Promise<OpenSubtitlesDownloadedSubtitle> {
        const result = request.result;
        if (!Number.isInteger(result.fileId) || result.fileId < 0) {
            throw new Error('OpenSubtitles returned an invalid file id.');
        }

        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error(
                'OpenSubtitles is not configured. Set OPENSUBTITLES_API_KEY before starting ARM-Nator.'
            );
        }

        await mkdir(this.cacheDirectory, { recursive: true });
        const metadataPath = join(
            this.cacheDirectory,
            `${result.fileId}.json`
        );
        const cached = await this.readCached(metadataPath, result.fileId);
        if (cached) {
            return cached;
        }

        const downloadUrl = new URL(OPEN_SUBTITLES_URL.replace(/subtitles$/, 'download'));
        const downloadResponse = await fetch(downloadUrl, {
            method: 'POST',
            headers: this.headers(apiKey, true),
            body: JSON.stringify({ file_id: result.fileId }),
            signal: AbortSignal.timeout(15_000),
        });
        const downloadBody = await downloadResponse.text();
        if (!downloadResponse.ok) {
            throw new Error(errorMessage(downloadResponse.status, downloadBody));
        }

        let payload: { link?: unknown; file_name?: unknown };
        try {
            payload = JSON.parse(downloadBody) as {
                link?: unknown;
                file_name?: unknown;
            };
        } catch {
            throw new Error('OpenSubtitles returned an unreadable download response.');
        }

        const link = asString(payload.link);
        if (!link) {
            throw new Error('OpenSubtitles did not return a download link.');
        }

        const subtitleResponse = await fetch(link, {
            method: 'GET',
            headers: {
                Accept: '*/*',
                'User-Agent': OPEN_SUBTITLES_USER_AGENT,
            },
            signal: AbortSignal.timeout(15_000),
        });
        if (!subtitleResponse.ok) {
            throw new Error(
                `OpenSubtitles subtitle download failed with HTTP ${subtitleResponse.status}.`
            );
        }

        const data = Buffer.from(await subtitleResponse.arrayBuffer());
        const fileName = sanitizeFilename(
            asString(payload.file_name, result.fileName)
        );
        const filePath = join(
            this.cacheDirectory,
            `${result.fileId}-${fileName}`
        );
        const metadata: SubtitleCacheMetadata = {
            fileId: result.fileId,
            fileName,
            language: result.language,
            label: result.release || result.fileName,
            filePath,
        };
        await writeFile(filePath, data, { flag: 'wx' }).catch(async (error: unknown) => {
            if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
                throw error;
            }
        });
        await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');

        return {
            fileId: metadata.fileId,
            fileName: metadata.fileName,
            language: metadata.language,
            label: metadata.label,
            cacheHit: false,
            filePath: metadata.filePath,
            webVttDataUrl: toWebVttDataUrl(data, metadata.fileName),
        };
    }

    async clearCache(): Promise<void> {
        await rm(this.cacheDirectory, { recursive: true, force: true });
    }

    private async readCached(
        metadataPath: string,
        fileId: number
    ): Promise<OpenSubtitlesDownloadedSubtitle | null> {
        try {
            const metadata = JSON.parse(
                await readFile(metadataPath, 'utf8')
            ) as SubtitleCacheMetadata;
            if (
                metadata.fileId !== fileId ||
                !isInside(this.cacheDirectory, metadata.filePath)
            ) {
                return null;
            }
            const data = await readFile(metadata.filePath);
            return {
                fileId: metadata.fileId,
                fileName: metadata.fileName,
                language: metadata.language,
                label: metadata.label,
                cacheHit: true,
                filePath: metadata.filePath,
                webVttDataUrl: toWebVttDataUrl(data, metadata.fileName),
            };
        } catch {
            return null;
        }
    }
}

export const openSubtitlesService = new OpenSubtitlesService();
