import { STALKER_MAG_USER_AGENT } from '@arm-nator/shared/interfaces';

export interface UserAgentProfile {
    id: string;
    label: string;
    value: string;
}

/** Fixed compatibility profiles, not a claim to enumerate every possible agent. */
export const USER_AGENT_PROFILES: readonly UserAgentProfile[] = [
    { id: 'automatic', label: 'Automatic (app default)', value: '' },
    { id: 'mag250', label: 'MAG250 set-top box', value: STALKER_MAG_USER_AGENT },
    { id: 'mag254', label: 'MAG254 set-top box', value: STALKER_MAG_USER_AGENT.replace('MAG250', 'MAG254') },
    { id: 'mag322', label: 'MAG322 set-top box', value: STALKER_MAG_USER_AGENT.replace('MAG250', 'MAG322') },
    { id: 'vlc', label: 'VLC', value: 'VLC/3.0.21 LibVLC/3.0.21' },
    { id: 'ksplayer', label: 'KSPlayer', value: 'KSPlayer' },
    { id: 'kodi', label: 'Kodi', value: 'Kodi/21.0' },
    { id: 'android', label: 'Android browser', value: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
    { id: 'desktop', label: 'Desktop browser', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
];
