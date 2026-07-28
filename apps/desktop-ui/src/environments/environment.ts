import packageJson from '@package';

export const AppConfig = {
    production: false,
    environment: 'LOCAL',
    version: packageJson.version,
};
