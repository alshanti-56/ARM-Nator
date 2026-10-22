import type { Config } from 'jest';

const config: Config = {
    displayName: 'player-ui',
    preset: '../../../jest.preset.js',
    testEnvironment: 'jsdom',
    testMatch: ['<rootDir>/src/lib/workspace-player/auto-activity.component.spec.ts'],
    setupFilesAfterEnv: ['<rootDir>/../../providers/stalker/feature/src/test-setup.ts'],
    transform: {
        '^.+\\.(ts|mjs|js|html)$': [
            'jest-preset-angular',
            {
                tsconfig: '<rootDir>/tsconfig.lib.json',
                stringifyContentPathRegex: '\\.(html|svg)$',
            },
        ],
    },
    coverageDirectory: '../../../coverage/libs/player/ui',
};

export default config;
